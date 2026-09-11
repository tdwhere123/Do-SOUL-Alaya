import {
  ASSOCIATION_DOMAIN_ID,
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  ConditionalFieldIdSchema,
  QueryHoleSchema,
  QueryHypothesisSchema,
  QueryInterpretationSchema,
  QueryTimeWindowSchema,
  QueryViewSchema,
  type Guard,
  type QueryBinding,
  type QueryHole,
  type QueryHypothesis,
  type QueryInterpretation,
  type QueryInterpretationProposal,
  type QueryInterpretationStatus,
  type QueryProgram,
  type QueryTimeWindow,
  type QueryView,
  type RequestBudget
} from "@do-soul/alaya-protocol";
import { capContractKey } from "../cap-contract.js";
import { interpretQuery } from "../reference/interpret-query.js";
import { identityFor, type QueryDenotationParts } from "./compile-query-identity.js";
import {
  admitProposedGuard,
  type QueryProposalAdmission
} from "./query-proposal-admission.js";
import { QUERY_PROPOSAL_PRODUCER_REGISTRY_POLICY_VERSION } from "./query-proposal-producer-registry.js";
import { decodeSourceFilters } from "./ordinary-language.js";
import {
  classifyQueryPredicate,
  unsupportedPredicateHole,
  UNSUPPORTED_POLICY_QUERY_ID
} from "./source-predicates.js";

export const EPSILON: QueryProgram = { schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, kind: "epsilon" };

export type QueryRelation = Extract<QueryProgram, { readonly kind: "relation" }>;

export type QueryMemoryPort = Readonly<{
  readonly readAuthorizedSnapshot: (input: Readonly<{
    readonly snapshot_id: string;
    readonly budget: RequestBudget;
  }>) => void;
}>;

export type PredicateAdmission =
  | { readonly kind: "ok" }
  | { readonly kind: "malformed" }
  | { readonly kind: "unknown"; readonly holes: readonly QueryHole[] };

export function visitQueryProgram(program: QueryProgram, visit: (node: QueryProgram) => void): void {
  visit(program);
  if (program.kind === "sequence") {
    for (const step of program.steps) visitQueryProgram(step, visit);
    return;
  }
  if (program.kind === "alternative") {
    for (const option of program.options) visitQueryProgram(option, visit);
    return;
  }
  if (program.kind === "repeat" || program.kind === "closure") {
    visitQueryProgram(program.body, visit);
    return;
  }
  if (program.kind === "hyperedge") {
    for (const premise of program.premises) visitQueryProgram(premise, visit);
  }
}

export function collectRelations(program: QueryProgram): readonly QueryRelation[] {
  const relations: QueryRelation[] = [];
  visitQueryProgram(program, (node) => {
    if (node.kind === "relation") relations.push(node);
  });
  return relations;
}

export function collectRecoverableBindings(program: QueryProgram): readonly QueryBinding[] {
  const bindings: QueryBinding[] = [];
  visitQueryProgram(program, (node) => {
    if (node.kind !== "relation") return;
    if (node.guard.kind !== "source_bound_entity") return;
    if (node.guard.variable === undefined || node.guard.entity_id === undefined) return;
    bindings.push({
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      variable: node.guard.variable,
      value: node.guard.entity_id
    });
  });
  return bindings;
}

export function consumeMemoryIfNeeded(
  program: QueryProgram,
  snapshotId: string,
  budget: RequestBudget,
  memory: QueryMemoryPort | undefined
): void {
  if (memory === undefined) return;
  if (!collectRelations(program).some((relation) =>
    relation.guard.kind === "source_bound_entity" && relation.guard.entity_id !== undefined
  )) {
    return;
  }
  memory.readAuthorizedSnapshot({ snapshot_id: snapshotId, budget });
}

export function defaultView(): QueryView {
  return QueryViewSchema.parse({
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    requested_roles: ["requested", "associated"]
  });
}

export function requiredView(view: QueryView | undefined): QueryView | undefined {
  if (view === undefined) return defaultView();
  const parsed = QueryViewSchema.safeParse(view);
  return parsed.success ? parsed.data : undefined;
}

export function parseItems<T>(
  values: readonly T[] | undefined,
  schema: { readonly safeParse: (value: unknown) => { success: true; data: T } | { success: false } }
): readonly T[] | undefined {
  if (values === undefined) return [];
  const parsed: T[] = [];
  for (const item of values) {
    const result = schema.safeParse(item);
    if (!result.success) return undefined;
    parsed.push(result.data);
  }
  return parsed;
}

export function optionalWindow(
  window: QueryTimeWindow | undefined
): QueryTimeWindow | undefined | "invalid" {
  if (window === undefined) return undefined;
  const parsed = QueryTimeWindowSchema.safeParse(window);
  return parsed.success ? parsed.data : "invalid";
}

export function explicitQueryId(value: string | undefined): string | undefined | "invalid" {
  if (value === undefined) return undefined;
  const parsed = ConditionalFieldIdSchema.safeParse(value);
  return parsed.success ? parsed.data : "invalid";
}

export function fallbackQueryId(value: string | undefined, fallback: string): string {
  const parsed = value === undefined ? undefined : ConditionalFieldIdSchema.safeParse(value);
  return parsed?.success === true ? parsed.data : fallback;
}

export function denotation(
  proposal: QueryInterpretationProposal | undefined,
  parts: Omit<QueryDenotationParts, "interpretation_proposal" | "proposal_registry_policy_version" | "proposal_effective_limits">,
  extra?: Pick<QueryDenotationParts, "proposal_registry_policy_version" | "proposal_effective_limits">
): QueryDenotationParts {
  return {
    ...parts,
    ...extra,
    ...(proposal === undefined ? {} : { interpretation_proposal: proposal })
  };
}

export function denotationForAdmission(
  admission: QueryProposalAdmission,
  parts: Omit<QueryDenotationParts, "interpretation_proposal" | "proposal_registry_policy_version" | "proposal_effective_limits">
): QueryDenotationParts {
  if (admission.kind === "absent" || admission.kind === "invalid") {
    return denotation(undefined, parts);
  }
  return denotation(admission.stored_proposal, parts, {
    proposal_registry_policy_version: QUERY_PROPOSAL_PRODUCER_REGISTRY_POLICY_VERSION,
    proposal_effective_limits: admission.effective_limits
  });
}

export function proposalRejectedInterpretation(input: {
  readonly admission: Extract<QueryProposalAdmission, { kind: "unsupported" | "resource_rejected" | "malformed" }>;
  readonly query_id: string | undefined;
  readonly snapshot_id: string;
  readonly program: QueryProgram;
  readonly view: QueryView;
  readonly interpretation_clock?: string;
  readonly source_guard?: Guard;
  readonly time_window?: QueryTimeWindow;
  readonly authorized_scopes?: readonly string[] | null;
  readonly lexical_text?: string;
  readonly ordinary_request?: unknown;
}): QueryInterpretation {
  return interpretationOf({
    query_id: identityFor(input.query_id, denotationForAdmission(input.admission, {
      program: input.program,
      view: input.view,
      source_guard: input.source_guard,
      interpretation_clock: input.interpretation_clock,
      time_window: input.time_window,
      authorized_scopes: input.authorized_scopes,
      lexical_text: input.lexical_text,
      ordinary_request: input.ordinary_request
    })),
    status: input.admission.kind,
    snapshot_id: input.snapshot_id,
    program: input.program,
    view: input.view,
    source_guard: input.source_guard,
    interpretation_clock: input.interpretation_clock,
    time_window: input.time_window,
    interpretation_proposal: input.admission.stored_proposal
  });
}

export function associativeCapDomainAdmission(view: QueryView): "ok" | "incompatible" {
  if ((view.enumeration_policy ?? "canonical") !== "associative") return "ok";
  const contracts = view.cap_contracts ?? [];
  if (contracts.length === 0) return "incompatible";
  const keys = new Set(contracts.map(capContractKey));
  if (keys.size !== 1) return "incompatible";
  return contracts[0]?.domain_id === ASSOCIATION_DOMAIN_ID ? "ok" : "incompatible";
}

export function admitQueryPredicates(
  program: QueryProgram,
  extraGuards: readonly Guard[] = []
): PredicateAdmission {
  const holes: QueryHole[] = [];
  try {
    for (const relation of collectRelations(program)) {
      if (admitPredicateName(relation.guard.predicate_name, holes) === "malformed") {
        return { kind: "malformed" };
      }
    }
    for (const guard of extraGuards) {
      if (admitPredicateName(guard.predicate_name, holes) === "malformed") {
        return { kind: "malformed" };
      }
    }
  } catch {
    return { kind: "malformed" };
  }
  return holes.length === 0 ? { kind: "ok" } : { kind: "unknown", holes };
}

export function admitBoundProposalFields(
  base: Readonly<{
    readonly program: QueryProgram;
    readonly holes: readonly QueryHole[];
    readonly hypotheses: readonly QueryHypothesis[];
  }>,
  admission: Extract<QueryProposalAdmission, { kind: "admitted" }> | undefined
): {
  readonly program: QueryProgram;
  readonly holes: readonly QueryHole[];
  readonly hypotheses: readonly QueryHypothesis[];
} {
  if (admission === undefined) return base;
  return {
    program: admission.program !== undefined && base.program.kind === "epsilon"
      ? admission.program
      : base.program,
    holes: mergeUniqueByHoleId(base.holes, admission.holes),
    hypotheses: mergeUniqueByHypothesisId(base.hypotheses, admission.hypotheses)
  };
}

export function admissionStatus(
  program: QueryProgram,
  holes: readonly QueryHole[],
  hypotheses: readonly QueryHypothesis[]
): QueryInterpretationStatus {
  if (interpretQuery(program).kind === "unsupported") return "unsupported";
  if (hypotheses.length > 0) return "hypotheses";
  if (holes.some((hole) => hole.status !== "bound")) return "partial";
  if (collectRelations(program).some(({ guard }) => unknownUnresolvedPredicate(guard))) return "partial";
  return "resolved";
}

export function interpretationOf(input: {
  readonly query_id: string;
  readonly status: QueryInterpretationStatus;
  readonly snapshot_id: string;
  readonly program: QueryProgram;
  readonly source_guard?: Guard;
  readonly view: QueryView;
  readonly holes?: readonly QueryHole[];
  readonly hypotheses?: readonly QueryHypothesis[];
  readonly interpretation_clock?: string;
  readonly time_window?: QueryTimeWindow;
  readonly interpretation_proposal?: QueryInterpretationProposal;
}): QueryInterpretation {
  return QueryInterpretationSchema.parse({
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    query_id: input.query_id,
    status: input.status,
    snapshot_id: input.snapshot_id,
    program: input.program,
    ...(input.source_guard === undefined ? {} : { source_guard: input.source_guard }),
    view: input.view,
    holes: input.holes ?? [],
    hypotheses: input.hypotheses ?? [],
    ...(input.interpretation_clock === undefined
      ? {}
      : { interpretation_clock: input.interpretation_clock }),
    ...(input.time_window === undefined ? {} : { time_window: input.time_window }),
    ...(input.interpretation_proposal === undefined
      ? {}
      : { interpretation_proposal: input.interpretation_proposal })
  });
}

export function incompatibleCapInterpretation(input: {
  readonly query_id: string | undefined;
  readonly snapshot_id: string;
  readonly program: QueryProgram;
  readonly view: QueryView;
  readonly interpretation_clock?: string;
  readonly interpretation_proposal?: QueryInterpretationProposal;
}): QueryInterpretation {
  return interpretationOf({
    query_id: fallbackQueryId(input.query_id, UNSUPPORTED_POLICY_QUERY_ID),
    status: "unsupported",
    snapshot_id: input.snapshot_id,
    program: input.program,
    view: input.view,
    interpretation_clock: input.interpretation_clock,
    interpretation_proposal: input.interpretation_proposal
  });
}

export function extraGuardsForAdmission(
  sourceGuard: Guard | undefined,
  conditions: readonly Guard[] = []
): readonly Guard[] {
  return [
    ...(sourceGuard === undefined ? [] : [sourceGuard]),
    ...conditions
  ];
}

export function admittedProposalConditions(
  proposal: QueryInterpretationProposal | undefined
): readonly Guard[] {
  return (proposal?.conditions ?? []).map(admitProposedGuard);
}

function admitPredicateName(
  name: string | undefined,
  holes: QueryHole[]
): "ok" | "malformed" {
  const classified = classifyQueryPredicate(name);
  if (classified.kind === "memory_filters") {
    decodeSourceFilters(name);
    return "ok";
  }
  if (classified.kind === "unknown" && holes.length === 0) {
    holes.push(unsupportedPredicateHole());
  }
  return "ok";
}

function unknownUnresolvedPredicate(guard: Guard): boolean {
  if (guard.kind !== "query_predicate" || guard.verdict !== "unresolved") return false;
  return classifyQueryPredicate(guard.predicate_name).kind === "unknown";
}

function mergeUniqueByHoleId(
  base: readonly QueryHole[],
  extra: readonly QueryHole[] | undefined
): readonly QueryHole[] {
  if (extra === undefined || extra.length === 0) return base;
  const seen = new Set(base.map((hole) => hole.hole_id));
  const merged = [...base];
  for (const hole of extra) {
    const parsed = QueryHoleSchema.safeParse(hole);
    if (!parsed.success || seen.has(parsed.data.hole_id)) continue;
    seen.add(parsed.data.hole_id);
    merged.push(parsed.data);
  }
  return merged;
}

function mergeUniqueByHypothesisId(
  base: readonly QueryHypothesis[],
  extra: readonly QueryHypothesis[] | undefined
): readonly QueryHypothesis[] {
  if (extra === undefined || extra.length === 0) return base;
  const seen = new Set(base.map((row) => row.hypothesis_id));
  const merged = [...base];
  for (const row of extra) {
    const parsed = QueryHypothesisSchema.safeParse(row);
    if (!parsed.success || seen.has(parsed.data.hypothesis_id)) continue;
    seen.add(parsed.data.hypothesis_id);
    merged.push(parsed.data);
  }
  return merged;
}
