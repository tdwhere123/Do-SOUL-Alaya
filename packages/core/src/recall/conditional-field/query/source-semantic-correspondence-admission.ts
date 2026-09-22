import {
  SOURCE_SEMANTIC_CONTEXT_CONTRACT,
  SourceSemanticCorrespondenceSchema,
  SourceSemanticInterpretationSchema,
  sourceSemanticCorrespondenceIdentity,
  sourceSemanticContextIdentity,
  sourceSemanticInterpretationIdentity,
  sourceSemanticContextContains,
  type SourceSemanticCorrespondence,
  type SourceSemanticConsumedLeaf,
  type SourceSemanticEndpointCorrespondence,
  type SourceSemanticEvaluationContext,
  type SourceSemanticInterpretation,
  type SourceSemanticQuery,
  type SourceSemanticQueryEndpoint,
  type SourceSemanticSourceEndpoint,
  type SourceSemanticSupport
} from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "../../../shared/field-hash.js";
import { admitSourceSemanticQuery } from "./source-semantic-query-admission.js";
import {
  defaultSourceSemanticCorrespondenceProducerRegistry,
  type SourceSemanticCorrespondenceProducerRecord,
  type SourceSemanticCorrespondenceProducerRegistry
} from "./source-semantic-correspondence-producer-registry.js";

/**
 * conditional-computation identity coordinate. Compilation (later lowering onto the existing
 * engine) owns the actual lowering; this admission only records the version.
 * Distinct lowering versions must not splice into one conditional computation.
 */
export const SOURCE_SEMANTIC_LOWERING_VERSION = "source-semantic-lowering-v6" as const;

export type SourceSemanticCorrespondenceAdmissionInput = Readonly<{
  readonly semantic_correspondence: unknown;
  readonly source_interpretation: unknown;
  readonly query_semantics: unknown;
  readonly original_query: string;
  readonly registry?: SourceSemanticCorrespondenceProducerRegistry;
}>;

export type SourceSemanticCorrespondenceAdmission =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid" }
  | { readonly kind: "unsupported" }
  | {
      readonly kind: "admitted";
      readonly semantic_correspondence: SourceSemanticCorrespondence;
      readonly semantic_correspondence_id: string;
      readonly query: SourceSemanticQuery;
      readonly query_id: string;
      readonly interpretation: SourceSemanticInterpretation;
      readonly interpretation_id: string;
      readonly context: SourceSemanticEvaluationContext;
      readonly context_id: string;
      readonly leaves: readonly SourceSemanticConsumedLeaf[];
      readonly producer: SourceSemanticCorrespondenceProducerRecord;
    };

/**
 * Core owner for semantic_correspondence admission and evaluation-context identity.
 * Checks structure: endpoints, types, context handles, producer, and
 * acyclic conditional computation = (source_interpretation_id, query_semantics_id, semantic_correspondence_id, k_version, lowering_version).
 * Does not prove the language truth of an admitted contextual equivalence.
 *
 * First-release relation is contextual_equivalence only. Directional
 * entailment (send⇒transfer) is not admitted; nested interiors do not
 * inherit an outer direction. related/unknown/unavailable/incompatible
 * are absences — they must not satisfy a query obligation. Correspondence
 * leaves never substitute for source-interpretation presence, binding, or assertion permission.
 */
export function admitSourceSemanticCorrespondence(
  input: SourceSemanticCorrespondenceAdmissionInput
): SourceSemanticCorrespondenceAdmission {
  if (input.semantic_correspondence === undefined) return { kind: "absent" };
  const parsed = SourceSemanticCorrespondenceSchema.safeParse(input.semantic_correspondence);
  if (!parsed.success) return { kind: "invalid" };
  const interpretation = SourceSemanticInterpretationSchema.safeParse(input.source_interpretation);
  if (!interpretation.success) return { kind: "invalid" };
  const queryAdmission = admitSourceSemanticQuery(input.query_semantics, input.original_query);
  if (queryAdmission.kind !== "admitted") {
    return { kind: queryAdmission.kind === "unsupported" ? "unsupported" : "invalid" };
  }
  // Semantic correspondence hashes query semantics; it cannot rewrite query semantics. Re-admitted query-semantics identity must be the bound query_semantics_id.
  if (parsed.data.query_semantics_id !== queryAdmission.query_id) return { kind: "invalid" };
  const interpretationId = sourceSemanticInterpretationIdentity(interpretation.data, fieldContractSha256);
  if (parsed.data.source_interpretation_id !== interpretationId) return { kind: "invalid" };
  const registry = input.registry ?? defaultSourceSemanticCorrespondenceProducerRegistry;
  const producer = registry.lookup(parsed.data.producer_id, parsed.data.producer_version);
  if (producer === undefined || !producer.capabilities.includes("semantic_correspondence")) {
    return { kind: "unsupported" };
  }
  if (parsed.data.correspondences.some((row) => !input.original_query.includes(row.query_support.excerpt))) return { kind: "invalid" };
  if (!validFiniteCorrespondence(parsed.data, interpretation.data, queryAdmission.query, input.original_query)) return { kind: "invalid" };
  const leaves = correspondenceLeaves(parsed.data, interpretation.data, queryAdmission.query);
  if (leaves === undefined) return { kind: "invalid" };
  const correspondenceId = sourceSemanticCorrespondenceIdentity(parsed.data, fieldContractSha256);
  const context: SourceSemanticEvaluationContext = {
    contract: SOURCE_SEMANTIC_CONTEXT_CONTRACT,
    source_interpretation_id: interpretationId,
    query_semantics_id: queryAdmission.query_id,
    semantic_correspondence_id: correspondenceId,
    k_version: interpretation.data.k_version,
    lowering_version: SOURCE_SEMANTIC_LOWERING_VERSION
  };
  return {
    kind: "admitted",
    semantic_correspondence: parsed.data,
    semantic_correspondence_id: correspondenceId,
    query: queryAdmission.query,
    query_id: queryAdmission.query_id,
    interpretation: interpretation.data,
    interpretation_id: interpretationId,
    context,
    context_id: sourceSemanticContextIdentity(context, fieldContractSha256),
    leaves,
    producer
  };
}

function validFiniteCorrespondence(semantic_correspondence: SourceSemanticCorrespondence, sourceInterpretation: SourceSemanticInterpretation,
  querySemantics: SourceSemanticQuery, text: string): boolean {
  const domains = new Map((sourceInterpretation.domains ?? []).map((row) => [row.id, row]));
  const seen = new Set<string>();
  for (const row of semantic_correspondence.domains ?? []) {
    if (!domains.has(row.source_domain) || !querySemantics.domains?.some((domain) => domain.id === row.query_domain)
      || seen.has(row.query_domain) || !text.includes(row.query_support.excerpt)
      || !supportOnInterpretation(row.source_semantic_support, sourceInterpretation)) return false;
    seen.add(row.query_domain);
  }
  const assumptions = new Set<string>();
  for (const row of semantic_correspondence.membership_assumptions ?? []) {
    const variable = querySemantics.variables.find((item) => item.id === row.query_variable), domain = domains.get(row.source_domain);
    const key = JSON.stringify([row.query_variable, row.source_domain]);
    if (variable?.sort !== "entity" || variable.reference === undefined || domain === undefined
      || assumptions.has(key) || !text.includes(row.query_support.excerpt)) return false;
    assumptions.add(key);
    if (row.restrictions.some((id) => !sourceInterpretation.operators.some((op) => op.operator === "forall"
      && op.domain === domain.id && op.restriction === id))) return false;
    const source = semantic_correspondence.correspondences.find((item) => item.query_endpoint.kind === "referent"
      && item.query_endpoint.variable === variable.id)?.source_endpoint;
    const referent = source?.kind === "referent" ? source.referent : undefined;
    if (row.status === "member" && (domain.exclusions.some((item) => item.referent === referent)
      || domain.closure.kind === "closed" && !domain.members.some((item) => item.referent === referent))) return false;
    if (row.status === "excluded" && domain.members.some((item) => item.referent === referent)) return false;
  }
  return true;
}

function correspondenceLeaves(
  semantic_correspondence: SourceSemanticCorrespondence,
  interpretation: SourceSemanticInterpretation,
  query: SourceSemanticQuery
): readonly SourceSemanticConsumedLeaf[] | undefined {
  const leaves: SourceSemanticConsumedLeaf[] = [];
  for (const [index, correspondence] of semantic_correspondence.correspondences.entries()) {
    const leaf = correspondenceLeaf(correspondence, index, interpretation, query);
    if (leaf === undefined) return undefined;
    leaves.push(leaf);
  }
  return leaves;
}

function correspondenceLeaf(
  correspondence: SourceSemanticEndpointCorrespondence,
  index: number,
  interpretation: SourceSemanticInterpretation,
  query: SourceSemanticQuery
): SourceSemanticConsumedLeaf | undefined {
  if (!supportOnInterpretation(correspondence.source_semantic_support, interpretation)) return undefined;
  const queryEndpoint = correspondence.query_endpoint;
  const sourceEndpoint = correspondence.source_endpoint;
  const context = correspondence.applicable_context;
  if (queryEndpoint.kind === "referent") {
    if (sourceEndpoint.kind !== "referent" || context !== undefined) return undefined;
    const variable = query.variables.find((row) => row.id === queryEndpoint.variable);
    const referent = interpretation.referents.find((row) => row.id === sourceEndpoint.referent);
    if (variable?.reference === undefined || variable.sort !== "entity" || referent === undefined
      || referent.referent_kind !== "grouped") return undefined;
    return { leaf_kind: "semantic_correspondence_referent", occurrence: referent.id, correspondence_index: index };
  }
  if (sourceEndpoint.kind === "referent") return undefined;
  if (context !== undefined && !sourceSemanticContextContains(interpretation, context, sourceEndpoint.frame)) return undefined;
  const queryFrame = queryFrameOf(query, queryEndpoint);
  const sourceFrame = sourceFrameOf(interpretation, sourceEndpoint);
  if (queryFrame === undefined || sourceFrame === undefined || queryFrame.operator !== undefined) return undefined;
  if (queryEndpoint.kind === "predicate") {
    if (sourceEndpoint.kind !== "frame") return undefined;
    return { leaf_kind: "semantic_correspondence_predicate", correspondence_index: index, occurrence: sourceFrame.id };
  }
  if (sourceEndpoint.kind !== "slot") return undefined;
  const querySlot = queryFrame.role_requirements.some((row) => row.id === queryEndpoint.slot);
  const sourceSlot = sourceFrame.slots.some((row) => row.id === sourceEndpoint.slot);
  if (!querySlot || !sourceSlot) return undefined;
  return {
    leaf_kind: "semantic_correspondence_slot",
    correspondence_index: index,
    occurrence: sourceFrame.id,
    slot_id: sourceEndpoint.slot
  };
}

function queryFrameOf(query: SourceSemanticQuery, endpoint: Exclude<SourceSemanticQueryEndpoint, { kind: "referent" }>) {
  const alternative = query.alternatives[endpoint.alternative];
  return alternative?.frames.find((frame) => frame.id === endpoint.frame);
}

function sourceFrameOf(interpretation: SourceSemanticInterpretation, endpoint: Exclude<SourceSemanticSourceEndpoint, { kind: "referent" }>) {
  return interpretation.frames.find((frame) => frame.id === endpoint.frame);
}

function supportOnInterpretation(
  support: readonly SourceSemanticSupport[],
  interpretation: SourceSemanticInterpretation
): boolean {
  const mentions = new Set(interpretation.mentions.map((row) => row.id));
  const nodes = new Set([
    ...interpretation.referents.map((row) => row.id),
    ...interpretation.frames.map((row) => row.id),
    ...interpretation.operators.map((row) => row.id)
  ]);
  for (const item of support) {
    if (item.kind === "lexical" || item.kind === "additional") {
      if (item.mentions.some((id) => !mentions.has(id))) return false;
    } else if (!nodes.has(item.via_id)) {
      return false;
    }
  }
  return true;
}
