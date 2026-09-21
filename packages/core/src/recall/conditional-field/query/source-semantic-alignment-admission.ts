import {
  SOURCE_SEMANTIC_CONTEXT_CONTRACT,
  SourceSemanticAlignmentSchema,
  SourceSemanticInterpretationSchema,
  sourceSemanticAlignmentIdentity,
  sourceSemanticContextIdentity,
  sourceSemanticInterpretationIdentity,
  sourceSemanticContextContains,
  type SourceSemanticAlignment,
  type SourceSemanticConsumedLeaf,
  type SourceSemanticCorrespondence,
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
  defaultSourceSemanticAlignmentProducerRegistry,
  type SourceSemanticAlignmentProducerRecord,
  type SourceSemanticAlignmentProducerRegistry
} from "./source-semantic-alignment-producer-registry.js";

/**
 * C identity coordinate. Compilation (later lowering onto the existing
 * engine) owns the actual lowering; this admission only records the version.
 * Distinct lowering versions must not splice into one C.
 */
export const SOURCE_SEMANTIC_LOWERING_VERSION = "source-semantic-lowering-v4" as const;

export type SourceSemanticAlignmentAdmissionInput = Readonly<{
  readonly alignment: unknown;
  readonly h: unknown;
  readonly q: unknown;
  readonly original_query: string;
  readonly registry?: SourceSemanticAlignmentProducerRegistry;
}>;

export type SourceSemanticAlignmentAdmission =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid" }
  | { readonly kind: "unsupported" }
  | {
      readonly kind: "admitted";
      readonly alignment: SourceSemanticAlignment;
      readonly alignment_id: string;
      readonly query: SourceSemanticQuery;
      readonly query_id: string;
      readonly interpretation: SourceSemanticInterpretation;
      readonly interpretation_id: string;
      readonly context: SourceSemanticEvaluationContext;
      readonly context_id: string;
      readonly leaves: readonly SourceSemanticConsumedLeaf[];
      readonly producer: SourceSemanticAlignmentProducerRecord;
    };

/**
 * Core owner for alignment admission and evaluation-context identity.
 * Checks structure: endpoints, types, context handles, producer, and
 * acyclic C = (h_id, q_id, a_id, k_version, lowering_version).
 * Does not prove the language truth of an admitted contextual equivalence.
 *
 * First-release relation is contextual_equivalence only. Directional
 * entailment (send⇒transfer) is not admitted; nested interiors do not
 * inherit an outer direction. related/unknown/unavailable/incompatible
 * are absences — they must not satisfy a query obligation. Correspondence
 * leaves never substitute for H presence, binding, or assertion permission.
 */
export function admitSourceSemanticAlignment(
  input: SourceSemanticAlignmentAdmissionInput
): SourceSemanticAlignmentAdmission {
  if (input.alignment === undefined) return { kind: "absent" };
  const parsed = SourceSemanticAlignmentSchema.safeParse(input.alignment);
  if (!parsed.success) return { kind: "invalid" };
  const interpretation = SourceSemanticInterpretationSchema.safeParse(input.h);
  if (!interpretation.success) return { kind: "invalid" };
  const queryAdmission = admitSourceSemanticQuery(input.q, input.original_query);
  if (queryAdmission.kind !== "admitted") {
    return { kind: queryAdmission.kind === "unsupported" ? "unsupported" : "invalid" };
  }
  // A hashes Q; it cannot rewrite Q. Re-admitted Q identity must be the bound q_id.
  if (parsed.data.q_id !== queryAdmission.query_id) return { kind: "invalid" };
  const interpretationId = sourceSemanticInterpretationIdentity(interpretation.data, fieldContractSha256);
  if (parsed.data.h_id !== interpretationId) return { kind: "invalid" };
  const registry = input.registry ?? defaultSourceSemanticAlignmentProducerRegistry;
  const producer = registry.lookup(parsed.data.producer_id, parsed.data.producer_version);
  if (producer === undefined || !producer.capabilities.includes("semantic_alignment")) {
    return { kind: "unsupported" };
  }
  if (parsed.data.correspondences.some((row) => !input.original_query.includes(row.query_support.excerpt))) return { kind: "invalid" };
  if (!validFiniteAlignment(parsed.data, interpretation.data, queryAdmission.query, input.original_query)) return { kind: "invalid" };
  const leaves = alignmentLeaves(parsed.data, interpretation.data, queryAdmission.query);
  if (leaves === undefined) return { kind: "invalid" };
  const alignmentId = sourceSemanticAlignmentIdentity(parsed.data, fieldContractSha256);
  const context: SourceSemanticEvaluationContext = {
    contract: SOURCE_SEMANTIC_CONTEXT_CONTRACT,
    h_id: interpretationId,
    q_id: queryAdmission.query_id,
    a_id: alignmentId,
    k_version: interpretation.data.k_version,
    lowering_version: SOURCE_SEMANTIC_LOWERING_VERSION
  };
  return {
    kind: "admitted",
    alignment: parsed.data,
    alignment_id: alignmentId,
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

function validFiniteAlignment(alignment: SourceSemanticAlignment, h: SourceSemanticInterpretation,
  q: SourceSemanticQuery, text: string): boolean {
  const domains = new Map((h.domains ?? []).map((row) => [row.id, row]));
  const seen = new Set<string>();
  for (const row of alignment.domains ?? []) {
    if (!domains.has(row.source_domain) || !q.domains?.some((domain) => domain.id === row.query_domain)
      || seen.has(row.query_domain) || !text.includes(row.query_support.excerpt)
      || !supportOnInterpretation(row.source_semantic_support, h)) return false;
    seen.add(row.query_domain);
  }
  const assumptions = new Set<string>();
  for (const row of alignment.membership_assumptions ?? []) {
    const variable = q.variables.find((item) => item.id === row.query_variable), domain = domains.get(row.source_domain);
    const key = JSON.stringify([row.query_variable, row.source_domain]);
    if (variable?.sort !== "entity" || variable.reference === undefined || domain === undefined
      || assumptions.has(key) || !text.includes(row.query_support.excerpt)) return false;
    assumptions.add(key);
    if (row.restrictions.some((id) => !h.operators.some((op) => op.operator === "forall"
      && op.domain === domain.id && op.restriction === id))) return false;
    const source = alignment.correspondences.find((item) => item.query_endpoint.kind === "referent"
      && item.query_endpoint.variable === variable.id)?.source_endpoint;
    const referent = source?.kind === "referent" ? source.referent : undefined;
    if (row.status === "member" && (domain.exclusions.some((item) => item.referent === referent)
      || domain.closure.kind === "closed" && !domain.members.some((item) => item.referent === referent))) return false;
    if (row.status === "excluded" && domain.members.some((item) => item.referent === referent)) return false;
  }
  return true;
}

function alignmentLeaves(
  alignment: SourceSemanticAlignment,
  interpretation: SourceSemanticInterpretation,
  query: SourceSemanticQuery
): readonly SourceSemanticConsumedLeaf[] | undefined {
  const leaves: SourceSemanticConsumedLeaf[] = [];
  for (const [index, correspondence] of alignment.correspondences.entries()) {
    const leaf = correspondenceLeaf(correspondence, index, interpretation, query);
    if (leaf === undefined) return undefined;
    leaves.push(leaf);
  }
  return leaves;
}

function correspondenceLeaf(
  correspondence: SourceSemanticCorrespondence,
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
    return { leaf_kind: "a_referent", occurrence: referent.id, correspondence_index: index };
  }
  if (sourceEndpoint.kind === "referent") return undefined;
  if (context !== undefined && !sourceSemanticContextContains(interpretation, context, sourceEndpoint.frame)) return undefined;
  const queryFrame = queryFrameOf(query, queryEndpoint);
  const sourceFrame = sourceFrameOf(interpretation, sourceEndpoint);
  if (queryFrame === undefined || sourceFrame === undefined || queryFrame.operator !== undefined) return undefined;
  if (queryEndpoint.kind === "predicate") {
    if (sourceEndpoint.kind !== "frame") return undefined;
    return { leaf_kind: "a_predicate", correspondence_index: index, occurrence: sourceFrame.id };
  }
  if (sourceEndpoint.kind !== "slot") return undefined;
  const querySlot = queryFrame.role_requirements.some((row) => row.id === queryEndpoint.slot);
  const sourceSlot = sourceFrame.slots.some((row) => row.id === sourceEndpoint.slot);
  if (!querySlot || !sourceSlot) return undefined;
  return {
    leaf_kind: "a_slot",
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
