import {
  CONDITIONAL_FIELD_SCHEMA_VERSION, IsoDatetimeStringSchema, QueryProgramSchema,
  type Guard, type QueryHole, type QueryInterpretation, type QueryTimeWindow, type QueryView, type RequestBudget
} from "@do-soul/alaya-protocol";
import { identityFor, type QueryDenotationParts } from "./compile-query-identity.js";
import type { OrdinaryLanguageCompileInput } from "./compile-query.js";
import {
  attachSourceFilters, encodeSourceFilters, normalizeOrdinaryText, proposeOrdinaryRelations,
  programFromOpenRelations, SourceFilterCapacityError, uninterpretedQueryHole, anchorTimeGuard,
  type OrdinarySourceFilters
} from "./ordinary-language.js";
import {
  admissionStatus, admitBoundProposalFields, admitQueryPredicates, associativeCapDomainAdmission,
  consumeMemoryIfNeeded, denotationForAdmission, EPSILON, extraGuardsForAdmission, fallbackQueryId,
  incompatibleCapInterpretation, interpretationOf, optionalWindow, proposalRejectedInterpretation
} from "./query-admission.js";
import { admitQueryProposal } from "./query-proposal-admission.js";

const MAX_ORDINARY_TEXT = 4096;

function ordinaryRestriction(input: OrdinaryLanguageCompileInput):
  Pick<QueryDenotationParts, "source_id" | "access_hint"> {
  return {
    ...(input.source_id === undefined ? {} : { source_id: input.source_id }),
    ...(input.access_hint === undefined ? {} : { access_hint: input.access_hint })
  };
}

type TimeHints =
  | { readonly kind: "none" }
  | { readonly kind: "window"; readonly window: QueryTimeWindow }
  | { readonly kind: "partial"; readonly since?: string; readonly until?: string }
  | { readonly kind: "invalid" };

export function compileOrdinary(input: OrdinaryLanguageCompileInput, snapshotId: string,
  budget: RequestBudget, view: QueryView, queryId: string | undefined): QueryInterpretation {
  if (associativeCapDomainAdmission(view) === "incompatible") {
    return incompatibleCapInterpretation({ query_id: queryId, snapshot_id: snapshotId,
      program: EPSILON, view, interpretation_clock: input.interpretation_clock });
  }
  const hints = compileTimeHints(input.since, input.until);
  if (input.text.length > MAX_ORDINARY_TEXT || normalizeOrdinaryText(input.text).length === 0
    || !IsoDatetimeStringSchema.safeParse(input.interpretation_clock).success || hints.kind === "invalid") {
    return ordinaryMalformed(input, snapshotId, view);
  }
  const proposal = admitQueryProposal(input.interpretation_proposal, input.text,
    input.proposal_registry, input.interpretation_clock);
  if (proposal.kind === "invalid") return ordinaryMalformed(input, snapshotId, view);
  if (proposal.kind === "unsupported" || proposal.kind === "resource_rejected" || proposal.kind === "malformed") {
    return proposalRejectedInterpretation({ admission: proposal, query_id: queryId,
      snapshot_id: snapshotId, program: EPSILON, view, interpretation_clock: input.interpretation_clock,
      authorized_scopes: input.authorized_scopes, ...ordinaryRestriction(input), lexical_text: input.text });
  }
  const relations = input.relations ?? proposeOrdinaryRelations(input.text);
  try {
    const window = hints.kind === "window" ? hints.window : undefined;
    const compiled = relations.length === 0 ? EPSILON : programFromOpenRelations(relations,
      window === undefined ? undefined : anchorTimeGuard(window));
    const parsed = QueryProgramSchema.safeParse(compiled);
    if (!parsed.success || admitQueryPredicates(parsed.data).kind === "malformed") {
      return ordinaryMalformed(input, snapshotId, view);
    }
    const filters = sourceFiltersFrom(input, hints);
    const program = relations.length === 0 ? EPSILON : attachSourceFilters(parsed.data, filters);
    const predicate = relations.length === 0 ? encodeSourceFilters(filters) : undefined;
    const sourceGuard: Guard | undefined = predicate === undefined ? undefined : {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, kind: "query_predicate",
      verdict: "unresolved", time_scope: "none", predicate_name: predicate
    };
    consumeMemoryIfNeeded(program, snapshotId, budget, input.memory);
    return finishOrdinary(input, snapshotId, view, queryId, proposal, relations, interpretationOf({
      query_id: fallbackQueryId(queryId, "ordinary"), status: "partial", snapshot_id: snapshotId,
      program, view, holes: [...(relations.length === 0 ? [uninterpretedQueryHole()] : []), ...openEndpointHoles(hints)],
      source_guard: sourceGuard, interpretation_clock: input.interpretation_clock, time_window: window
    }));
  } catch (error) {
    if (!(error instanceof SourceFilterCapacityError)) throw error;
    return interpretationOf({ query_id: fallbackQueryId(input.query_id, "resource-rejected"),
      status: "resource_rejected", snapshot_id: snapshotId, program: EPSILON, view,
      interpretation_clock: input.interpretation_clock });
  }
}

function finishOrdinary(input: OrdinaryLanguageCompileInput, snapshotId: string, view: QueryView,
  queryId: string | undefined, proposal: ReturnType<typeof admitQueryProposal>,
  relations: OrdinaryLanguageCompileInput["relations"], interpreted: QueryInterpretation): QueryInterpretation {
  const admitted = admitBoundProposalFields({ program: interpreted.program, holes: interpreted.holes,
    hypotheses: interpreted.hypotheses }, proposal.kind === "admitted" ? proposal : undefined);
  const predicates = admitQueryPredicates(admitted.program, extraGuardsForAdmission(
    interpreted.source_guard, proposal.kind === "admitted" ? proposal.conditions : []));
  if (predicates.kind === "malformed") return ordinaryMalformed(input, snapshotId, view);
  const holes = predicates.kind === "unknown" ? [...admitted.holes, ...predicates.holes] : admitted.holes;
  return interpretationOf({
    query_id: identityFor(queryId, denotationForAdmission(proposal, {
      program: admitted.program, view: interpreted.view, hypotheses: admitted.hypotheses,
      source_guard: interpreted.source_guard, interpretation_clock: input.interpretation_clock,
      time_window: interpreted.time_window, authorized_scopes: input.authorized_scopes,
      ...ordinaryRestriction(input), lexical_text: input.text, ordinary_request: { relations, query_id: queryId }
    })),
    status: admissionStatus(admitted.program, holes, admitted.hypotheses), snapshot_id: snapshotId,
    program: admitted.program, view: interpreted.view, holes, hypotheses: admitted.hypotheses,
    source_guard: interpreted.source_guard, interpretation_clock: input.interpretation_clock,
    time_window: interpreted.time_window,
    interpretation_proposal: proposal.kind === "admitted" ? proposal.stored_proposal : undefined
  });
}

function ordinaryMalformed(input: OrdinaryLanguageCompileInput, snapshotId: string, view: QueryView): QueryInterpretation {
  return interpretationOf({ query_id: fallbackQueryId(input.query_id, "malformed"), status: "malformed",
    snapshot_id: snapshotId, program: EPSILON, view, interpretation_clock: input.interpretation_clock });
}

function compileTimeHints(since: string | undefined, until: string | undefined): TimeHints {
  if (since === undefined && until === undefined) return { kind: "none" };
  if (since !== undefined && until !== undefined) {
    const parsed = optionalWindow({ start: since, end: until });
    return parsed === "invalid" || parsed === undefined ? { kind: "invalid" } : { kind: "window", window: parsed };
  }
  const present = since ?? until;
  if (present === undefined || !IsoDatetimeStringSchema.safeParse(present).success) return { kind: "invalid" };
  return { kind: "partial", ...(since === undefined ? {} : { since }), ...(until === undefined ? {} : { until }) };
}

function openEndpointHoles(hints: TimeHints): readonly QueryHole[] {
  if (hints.kind !== "partial") return [];
  return [{ schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    hole_id: hints.since === undefined ? "hole.time.since" : "hole.time.until", variable: "r", status: "open" }];
}

function sourceFiltersFrom(input: OrdinaryLanguageCompileInput, hints: TimeHints): OrdinarySourceFilters {
  const since = hints.kind === "window" ? hints.window.start : hints.kind === "partial" ? hints.since : input.since;
  const until = hints.kind === "window" ? hints.window.end : hints.kind === "partial" ? hints.until : input.until;
  return {
    ...(input.dimension_filter === undefined || input.dimension_filter.length === 0 ? {} : { dimension_filter: input.dimension_filter }),
    ...(input.domain_tag_filter === undefined || input.domain_tag_filter.length === 0 ? {} : { domain_tag_filter: input.domain_tag_filter }),
    ...(input.time_field === undefined ? {} : { time_field: input.time_field }),
    ...(since === undefined ? {} : { since }), ...(until === undefined ? {} : { until })
  };
}
