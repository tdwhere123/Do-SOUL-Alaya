import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  IsoDatetimeStringSchema,
  QueryProgramSchema,
  type Guard,
  type QueryHole,
  type QueryHypothesis,
  type QueryInterpretation,
  type QueryProgram,
  type QueryTimeWindow,
  type QueryView,
  type RequestBudget
} from "@do-soul/alaya-protocol";
import { identityFor } from "./compile-query-identity.js";
import type { OrdinaryLanguageCompileInput } from "./compile-query.js";
import {
  attachSourceFilters,
  calendarYesterdayWindow,
  classifyOrdinaryRequest,
  encodeSourceFilters,
  openAnchorTimeGuard,
  ordinaryRemainder,
  proposeOrdinaryRelations,
  programFromOpenRelations,
  SourceFilterCapacityError,
  supportedFailedDeploymentProgram,
  uninterpretedQueryHole,
  yesterdayAnchorGuard,
  type OrdinarySourceFilters
} from "./ordinary-language.js";
import {
  admissionStatus,
  admitBoundProposalFields,
  admitQueryPredicates,
  associativeCapDomainAdmission,
  consumeMemoryIfNeeded,
  denotation,
  denotationForAdmission,
  EPSILON,
  extraGuardsForAdmission,
  fallbackQueryId,
  incompatibleCapInterpretation,
  interpretationOf,
  optionalWindow,
  proposalRejectedInterpretation
} from "./query-admission.js";
import { admitQueryProposal } from "./query-proposal-admission.js";

const MAX_ORDINARY_TEXT = 4096;

type TimeHints =
  | { readonly kind: "none" }
  | { readonly kind: "window"; readonly window: QueryTimeWindow }
  | { readonly kind: "partial"; readonly since?: string; readonly until?: string }
  | { readonly kind: "invalid" };

export function compileOrdinary(
  input: OrdinaryLanguageCompileInput,
  snapshotId: string,
  budget: RequestBudget,
  view: QueryView,
  queryId: string | undefined
): QueryInterpretation {
  if (associativeCapDomainAdmission(view) === "incompatible") {
    return incompatibleCapInterpretation({
      query_id: queryId,
      snapshot_id: snapshotId,
      program: EPSILON,
      view,
      interpretation_clock: input.interpretation_clock
    });
  }
  if (input.text.length > MAX_ORDINARY_TEXT) {
    return ordinaryMalformed(input, snapshotId, view);
  }
  const yesterday = calendarYesterdayWindow(input.interpretation_clock);
  const hints = compileTimeHints(input.since, input.until);
  if (yesterday === undefined || hints.kind === "invalid") {
    return ordinaryMalformed(input, snapshotId, view);
  }
  const classified = classifyOrdinaryRequest(input.text);
  const proposal = admitQueryProposal(
    input.interpretation_proposal,
    input.text,
    input.proposal_registry
  );
  if (proposal.kind === "invalid") {
    return ordinaryMalformed(input, snapshotId, view);
  }
  if (proposal.kind === "unsupported" || proposal.kind === "resource_rejected" || proposal.kind === "malformed") {
    return proposalRejectedInterpretation({
      admission: proposal,
      query_id: queryId,
      snapshot_id: snapshotId,
      program: EPSILON,
      view,
      interpretation_clock: input.interpretation_clock,
      authorized_scopes: input.authorized_scopes,
      lexical_text: input.text
    });
  }
  const relations = input.relations ?? proposeOrdinaryRelations(input.text);
  let interpreted: QueryInterpretation;
  try {
    interpreted = relations.length > 0
      ? compileOpenRelations({ ...input, relations }, snapshotId, budget, view, queryId, classified, yesterday, hints)
      : classified.kind === "lexical"
        ? compileLexicalRequest(input, snapshotId, budget, view, queryId, hints)
        : compileSupportedRequest(input, snapshotId, budget, view, queryId, classified, yesterday, hints);
  } catch (error) {
    if (!(error instanceof SourceFilterCapacityError)) throw error;
    return interpretationOf({
      query_id: fallbackQueryId(input.query_id, "resource-rejected"),
      status: "resource_rejected",
      snapshot_id: snapshotId,
      program: EPSILON,
      view,
      interpretation_clock: input.interpretation_clock
    });
  }
  if (interpreted.status === "malformed" || interpreted.status === "resource_rejected") {
    return interpreted;
  }
  return finishOrdinary(input, snapshotId, view, queryId, proposal, relations, interpreted);
}

function finishOrdinary(
  input: OrdinaryLanguageCompileInput,
  snapshotId: string,
  view: QueryView,
  queryId: string | undefined,
  proposal: ReturnType<typeof admitQueryProposal>,
  relations: OrdinaryLanguageCompileInput["relations"],
  interpreted: QueryInterpretation
): QueryInterpretation {
  const admitted = admitBoundProposalFields({
    program: interpreted.program,
    holes: interpreted.holes,
    hypotheses: interpreted.hypotheses
  }, proposal.kind === "admitted" ? proposal : undefined);
  const predicates = admitQueryPredicates(
    admitted.program,
    extraGuardsForAdmission(
      interpreted.source_guard,
      proposal.kind === "admitted" ? proposal.conditions : []
    )
  );
  if (predicates.kind === "malformed") {
    return ordinaryMalformed(input, snapshotId, view);
  }
  const holes = predicates.kind === "unknown"
    ? [...admitted.holes, ...predicates.holes]
    : admitted.holes;
  return interpretationOf({
    query_id: identityFor(queryId, denotationForAdmission(proposal, {
      program: admitted.program,
      view: interpreted.view,
      hypotheses: admitted.hypotheses,
      source_guard: interpreted.source_guard,
      interpretation_clock: input.interpretation_clock,
      time_window: interpreted.time_window,
      authorized_scopes: input.authorized_scopes,
      lexical_text: input.text,
      ordinary_request: { relations, query_id: queryId }
    })),
    status: admissionStatus(admitted.program, holes, admitted.hypotheses),
    snapshot_id: snapshotId,
    program: admitted.program,
    view: interpreted.view,
    holes,
    hypotheses: admitted.hypotheses,
    source_guard: interpreted.source_guard,
    interpretation_clock: input.interpretation_clock,
    time_window: interpreted.time_window,
    interpretation_proposal: proposal.kind === "admitted" ? proposal.stored_proposal : undefined
  });
}

function compileSupportedRequest(
  input: OrdinaryLanguageCompileInput,
  snapshotId: string,
  budget: RequestBudget,
  view: QueryView,
  queryId: string | undefined,
  classified: ReturnType<typeof classifyOrdinaryRequest>,
  yesterday: QueryTimeWindow,
  hints: TimeHints
): QueryInterpretation {
  // Claim demand assesses common_cause; it must not hide an accepting associated product.
  view = { ...view, claim_demands: view.claim_demands ?? [{ variable: "h", proposition_kind: "common_cause", argument_variables: ["r", "h"], required_claim: "any" }] };
  if (classified.kind === "malformed") {
    return ordinaryMalformed(input, snapshotId, view);
  }
  if (classified.kind === "unsupported") {
    return interpretationOf({
      query_id: fallbackQueryId(queryId, "unsupported"),
      status: "unsupported",
      snapshot_id: snapshotId,
      program: EPSILON,
      view,
      interpretation_clock: input.interpretation_clock
    });
  }
  if (classified.kind === "lexical") {
    return compileLexicalRequest(input, snapshotId, budget, view, queryId, hints);
  }
  if (classified.kind === "hypotheses") {
    const program = admitOrdinaryProgram(
      supportedFailedDeploymentProgram(yesterdayAnchorGuard(yesterday)),
      input,
      hints
    );
    const hypotheses = ambiguousEventHypotheses();
    consumeMemoryIfNeeded(program, snapshotId, budget, input.memory);
    return interpretationOf({
      query_id: identityFor(queryId, denotation(undefined, {
        program,
        view,
        hypotheses,
        interpretation_clock: input.interpretation_clock,
        time_window: yesterday,
        authorized_scopes: input.authorized_scopes
      })),
      status: "hypotheses",
      snapshot_id: snapshotId,
      program,
      view,
      hypotheses,
      interpretation_clock: input.interpretation_clock,
      time_window: yesterday
    });
  }
  const window = classified.kind === "supported" ? yesterday : closedHintWindow(hints);
  const guard = window === undefined ? openAnchorTimeGuard() : yesterdayAnchorGuard(window);
  const program = admitOrdinaryProgram(supportedFailedDeploymentProgram(guard), input, hints);
  consumeMemoryIfNeeded(program, snapshotId, budget, input.memory);
  const holes = [
    ...(window === undefined ? [openTimeHole()] : []),
    ...(ordinaryRemainder(input.text).length > 0 ? [uninterpretedQueryHole()] : []),
    ...openEndpointHoles(hints)
  ];
  return interpretationOf({
    query_id: identityFor(queryId, denotation(undefined, {
      program,
      view,
      lexical_text: input.text,
      interpretation_clock: input.interpretation_clock,
      time_window: window,
      authorized_scopes: input.authorized_scopes
    })),
    status: admissionStatus(program, holes, []),
    snapshot_id: snapshotId,
    program,
    view,
    holes,
    interpretation_clock: input.interpretation_clock,
    ...(window === undefined ? {} : { time_window: window })
  });
}

function compileLexicalRequest(
  input: OrdinaryLanguageCompileInput,
  snapshotId: string,
  budget: RequestBudget,
  view: QueryView,
  queryId: string | undefined,
  hints: TimeHints
): QueryInterpretation {
  const program = EPSILON;
  const predicate = encodeSourceFilters(sourceFiltersFrom(input, hints));
  const sourceGuard: Guard | undefined = predicate === undefined ? undefined : {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, kind: "query_predicate",
    verdict: "unresolved", time_scope: "none", predicate_name: predicate
  };
  consumeMemoryIfNeeded(program, snapshotId, budget, input.memory);
  const holes = [uninterpretedQueryHole(), ...openEndpointHoles(hints)];
  const window = closedHintWindow(hints);
  return interpretationOf({
    query_id: identityFor(queryId, denotation(undefined, {
      program,
      view,
      interpretation_clock: input.interpretation_clock,
      time_window: window,
      authorized_scopes: input.authorized_scopes,
      lexical_text: input.text,
      source_guard: sourceGuard
    })),
    status: admissionStatus(program, holes, []),
    snapshot_id: snapshotId,
    program,
    view,
    holes,
    source_guard: sourceGuard,
    interpretation_clock: input.interpretation_clock,
    ...(window === undefined ? {} : { time_window: window })
  });
}

function compileOpenRelations(
  input: OrdinaryLanguageCompileInput,
  snapshotId: string,
  budget: RequestBudget,
  view: QueryView,
  queryId: string | undefined,
  classified: ReturnType<typeof classifyOrdinaryRequest>,
  yesterday: QueryTimeWindow,
  hints: TimeHints
): QueryInterpretation {
  const window = classified.kind === "supported" || classified.kind === "hypotheses"
    ? yesterday
    : closedHintWindow(hints);
  const compiled = programFromOpenRelations(
    input.relations ?? [],
    window === undefined ? undefined : yesterdayAnchorGuard(window)
  );
  const parsed = compiled === undefined ? undefined : QueryProgramSchema.safeParse(compiled);
  if (parsed === undefined || !parsed.success || admitQueryPredicates(parsed.data).kind === "malformed") {
    return ordinaryMalformed(input, snapshotId, view);
  }
  const program = admitOrdinaryProgram(parsed.data, input, hints);
  consumeMemoryIfNeeded(program, snapshotId, budget, input.memory);
  const holes = [
    ...(classified.kind === "partial" && window === undefined ? [openTimeHole()] : []),
    ...openEndpointHoles(hints)
  ];
  return interpretationOf({
    query_id: identityFor(queryId, denotation(undefined, {
      program,
      view,
      interpretation_clock: input.interpretation_clock,
      time_window: window,
      authorized_scopes: input.authorized_scopes
    })),
    status: admissionStatus(program, holes, []),
    snapshot_id: snapshotId,
    program,
    view,
    holes,
    interpretation_clock: input.interpretation_clock,
    ...(window === undefined ? {} : { time_window: window })
  });
}

function ordinaryMalformed(
  input: OrdinaryLanguageCompileInput,
  snapshotId: string,
  view: QueryView
): QueryInterpretation {
  return interpretationOf({
    query_id: fallbackQueryId(input.query_id, "malformed"),
    status: "malformed",
    snapshot_id: snapshotId,
    program: EPSILON,
    view,
    interpretation_clock: input.interpretation_clock
  });
}

function compileTimeHints(
  since: string | undefined,
  until: string | undefined
): TimeHints {
  if (since === undefined && until === undefined) return { kind: "none" };
  if (since !== undefined && until !== undefined) {
    const parsed = optionalWindow({ start: since, end: until });
    return parsed === "invalid" || parsed === undefined
      ? { kind: "invalid" }
      : { kind: "window", window: parsed };
  }
  const present = since ?? until;
  if (present === undefined || !IsoDatetimeStringSchema.safeParse(present).success) {
    return { kind: "invalid" };
  }
  return {
    kind: "partial",
    ...(since === undefined ? {} : { since }),
    ...(until === undefined ? {} : { until })
  };
}

function closedHintWindow(hints: TimeHints): QueryTimeWindow | undefined {
  return hints.kind === "window" ? hints.window : undefined;
}

function openEndpointHoles(hints: TimeHints): readonly QueryHole[] {
  if (hints.kind !== "partial") return [];
  if (hints.since !== undefined && hints.until === undefined) {
    return [{ schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, hole_id: "hole.time.until", variable: "r", status: "open" }];
  }
  if (hints.until !== undefined && hints.since === undefined) {
    return [{ schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, hole_id: "hole.time.since", variable: "r", status: "open" }];
  }
  return [];
}

function admitOrdinaryProgram(
  program: QueryProgram,
  input: OrdinaryLanguageCompileInput,
  hints: TimeHints
): QueryProgram {
  return attachSourceFilters(program, sourceFiltersFrom(input, hints));
}

function sourceFiltersFrom(
  input: OrdinaryLanguageCompileInput,
  hints: TimeHints
): OrdinarySourceFilters {
  const since = hints.kind === "window" ? hints.window.start : hints.kind === "partial" ? hints.since : input.since;
  const until = hints.kind === "window" ? hints.window.end : hints.kind === "partial" ? hints.until : input.until;
  return {
    ...(input.dimension_filter === undefined || input.dimension_filter.length === 0
      ? {}
      : { dimension_filter: input.dimension_filter }),
    ...(input.domain_tag_filter === undefined || input.domain_tag_filter.length === 0
      ? {}
      : { domain_tag_filter: input.domain_tag_filter }),
    ...(input.time_field === undefined ? {} : { time_field: input.time_field }),
    ...(since === undefined ? {} : { since }),
    ...(until === undefined ? {} : { until })
  };
}

function openTimeHole(): QueryHole {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    hole_id: "hole.anchor.time",
    variable: "r",
    status: "open"
  };
}

function ambiguousEventHypotheses(): readonly QueryHypothesis[] {
  return [
    hypothesis("h-failed-deployment", "event", "failed_deployment"),
    hypothesis("h-unresolved-event", "event", "unresolved")
  ];
}

function hypothesis(id: string, variable: string, value: string): QueryHypothesis {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    hypothesis_id: id,
    bindings: [{
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      variable,
      value
    }]
  };
}
