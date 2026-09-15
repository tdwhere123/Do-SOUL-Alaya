import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  normalizeMemoryObjectKeySurface,
  type ProposedGuard,
  type QueryHole,
  type QueryInterpretation,
  type QueryInterpretationProposal,
  type QueryView,
  type RequestBudget
} from "@do-soul/alaya-protocol";
import { compileConditionalFieldQuery } from "./compile-query.js";
import { digestOriginalQuery } from "./compile-query-identity.js";
import { uninterpretedQueryHole } from "./ordinary-language.js";
import { QUERY_PROPOSAL_CORE_PRODUCER_ID } from "./query-proposal-producer-registry.js";
import {
  encodeSourceProposalPredicate,
  normalizeSourceRolePhrase,
  type QuerySourceLookupMode,
  type QuerySourceRolePhrase
} from "./query-source-proposal.js";

export type {
  AdoptedSourceProposal,
  QuerySourceLookupMode,
  QuerySourceRolePhrase
} from "./query-source-proposal.js";
export {
  SOURCE_PROPOSAL_LOOKUP_PREFIX,
  adoptedSourceProposal,
  decodeSourceProposalPredicate,
  sourceProposalPhrases
} from "./query-source-proposal.js";

export type QuerySourceRelationSketch = Readonly<{
  readonly predicate: string;
  readonly arguments?: readonly QuerySourceRolePhrase[];
  readonly qualifiers?: readonly QuerySourceRolePhrase[];
}>;

export type QuerySourceSketch = Readonly<{
  readonly original_query: string;
  readonly source_anchor?: Readonly<{
    readonly root_id?: string;
    readonly revision?: string;
  }>;
  readonly relation?: QuerySourceRelationSketch;
  readonly since?: string;
  readonly until?: string;
  readonly unresolved_alternatives?: readonly string[];
  readonly lookup_mode?: QuerySourceLookupMode;
}>;

export function compileQuerySourceSketch(input: Readonly<{
  readonly snapshot_id: string;
  readonly budget: RequestBudget;
  readonly interpretation_clock: string;
  readonly sketch: QuerySourceSketch;
  readonly view?: QueryView;
  readonly query_id?: string;
  readonly authorized_scopes?: readonly string[] | null;
}>): QueryInterpretation {
  const sketch = input.sketch;
  const proposal = sourceSketchProposal(sketch);
  const interpretation = compileConditionalFieldQuery({
    source: "ordinary",
    text: sketch.original_query,
    interpretation_clock: input.interpretation_clock,
    snapshot_id: input.snapshot_id,
    budget: input.budget,
    ...(input.view === undefined ? {} : { view: input.view }),
    ...(input.query_id === undefined ? {} : { query_id: input.query_id }),
    ...(input.authorized_scopes === undefined ? {} : { authorized_scopes: input.authorized_scopes }),
    ...(sketch.since === undefined ? {} : { since: sketch.since }),
    ...(sketch.until === undefined ? {} : { until: sketch.until }),
    ...(proposal === undefined ? {} : { interpretation_proposal: proposal })
  });
  if (interpretation.status === "malformed" || interpretation.status === "resource_rejected") {
    return interpretation;
  }
  return attachSketchHoles(interpretation, sketch);
}

function sourceSketchProposal(sketch: QuerySourceSketch): QueryInterpretationProposal | undefined {
  const conditions = [
    ...sourceAnchorConditions(sketch.source_anchor),
    ...relationConditions(sketch)
  ];
  if (conditions.length === 0) return undefined;
  const holes = alternativeHoles(sketch.unresolved_alternatives ?? []);
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    original_query_digest: digestOriginalQuery(sketch.original_query),
    producer_id: QUERY_PROPOSAL_CORE_PRODUCER_ID,
    producer_version: "1",
    conditions,
    ...(holes.length === 0 ? {} : { holes })
  };
}

function relationConditions(sketch: QuerySourceSketch): readonly ProposedGuard[] {
  if (sketch.relation === undefined) return [];
  return [{
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    kind: "query_predicate",
    predicate_name: encodeSourceProposalPredicate({
      lookup_mode: sketch.lookup_mode ?? "proposal",
      predicate_key: normalizeMemoryObjectKeySurface(sketch.relation.predicate),
      arguments: (sketch.relation.arguments ?? []).map(normalizeSourceRolePhrase),
      qualifiers: (sketch.relation.qualifiers ?? []).map(normalizeSourceRolePhrase)
    })
  }];
}

function sourceAnchorConditions(
  anchor: QuerySourceSketch["source_anchor"]
): readonly ProposedGuard[] {
  if (anchor?.root_id === undefined) return [];
  return [{
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    kind: "query_predicate",
    predicate_name: "source.identity.v1",
    entity_id: anchor.root_id
  }];
}

function attachSketchHoles(
  interpretation: QueryInterpretation,
  sketch: QuerySourceSketch
): QueryInterpretation {
  const holes = mergeHoles(interpretation.holes, [
    uninterpretedQueryHole(),
    ...alternativeHoles(sketch.unresolved_alternatives ?? [])
  ]);
  return {
    ...interpretation,
    holes,
    status: holes.some((hole) => hole.status !== "bound") ? "partial" : interpretation.status
  };
}

function alternativeHoles(alternatives: readonly string[]): readonly QueryHole[] {
  return alternatives.map((_alternative, index) => ({
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    hole_id: `hole.query.alternative.${index + 1}`,
    variable: "q",
    status: "unresolved" as const
  }));
}

function mergeHoles(
  base: readonly QueryHole[],
  extra: readonly QueryHole[]
): readonly QueryHole[] {
  const seen = new Set(base.map((hole) => hole.hole_id));
  const merged = [...base];
  for (const hole of extra) {
    if (seen.has(hole.hole_id)) continue;
    seen.add(hole.hole_id);
    merged.push(hole);
  }
  return merged;
}
