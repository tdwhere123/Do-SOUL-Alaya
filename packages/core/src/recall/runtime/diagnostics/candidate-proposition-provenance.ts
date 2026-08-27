import {
  QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID,
  RULE_BASED_QUERY_FACT_FRAME_OPERATOR_ID
} from "@do-soul/alaya-protocol";
import { CONTENT_OWNED_ASSERTION_FACT_KEY_OPERATOR_ID } from
  "../../delivery/fine-assessment-selection/content-owned-fact-key.js";
import type { OpenSemanticFactorCompositionStatus } from
  "../../field/open-semantic-factors/composition-status.js";
import type {
  TypedFactFrameCopyGap,
  TypedFactFrameReceiptInput
} from "./capture-proof/typed-fact-frame-receipts.js";

export type { TypedFactFrameReceiptInput } from "./capture-proof/typed-fact-frame-receipts.js";

export const CANDIDATE_PROPOSITION_PROVENANCE_OPERATOR_ID =
  "candidate_proposition_provenance_v1" as const;

type ProvenanceUnavailableReason =
  | "certified_osf_receipt_absent"
  | "certified_osf_producer_mismatch"
  | "osf_formation_not_formed"
  | "osf_composition_absent"
  | "osf_composition_not_composed"
  | "osf_composition_truncated"
  | "osf_binding_not_attributed"
  | "typed_fact_frame_receipt_absent"
  | "typed_fact_frame_producer_absent"
  | "typed_fact_frame_formation_unavailable"
  | "typed_fact_frame_formation_ineligible"
  | "typed_fact_frame_formation_rejected"
  | "typed_fact_frame_query_producer_denied"
  | "content_owned_excluded"
  | "evidence_link_absent"
  | "polarity_receipt_absent"
  | "relation_validity_receipt_absent"
  | "supersession_receipt_absent"
  | "contradiction_receipt_absent";

type ProvenanceCoordinate<T> =
  | Readonly<{ readonly status: "available"; readonly value: T }>
  | Readonly<{ readonly status: "unavailable"; readonly reason: ProvenanceUnavailableReason }>;

export type QueryOsfFormationView = Readonly<{
  readonly status: "formed" | "ineligible" | "unavailable" | "rejected";
  readonly producer_operator_id: string | null;
}>;

export type QueryOsfCompletenessView = Readonly<{
  readonly query_producer_operator_id: string;
}>;

type OsfBindingView = Readonly<{
  readonly variable_id: string;
  readonly binding_identity: string;
  readonly semantic_identity: string;
  readonly evidence_id: string;
  readonly query_proposition_id?: string;
  readonly evidence_proposition_id?: string;
}>;

export type CompositionView = Readonly<{
  readonly status: OpenSemanticFactorCompositionStatus;
  readonly truncated: boolean;
  readonly bindings?: readonly OsfBindingView[];
}>;

type NamedPolarityReceipt = Readonly<{
  readonly producer_operator_id: string;
  readonly polarity: "positive" | "negative";
}>;

type NamedRelationValidityReceipt = Readonly<{
  readonly producer_operator_id: string;
  readonly validity: "active" | "expired" | "unknown";
}>;

type NamedSupersessionReceipt = Readonly<{
  readonly producer_operator_id: string;
  readonly standing: "current" | "superseded";
  readonly superseding_assertion_id?: string;
}>;

type NamedContradictionReceipt = Readonly<{
  readonly producer_operator_id: string;
  readonly standing: "contradicted" | "contradicting";
  readonly counterpart_id?: string;
}>;

type CandidatePropositionProvenanceCandidateInput = Readonly<{
  readonly candidate_key: string;
  readonly typed_fact_frames?: readonly TypedFactFrameReceiptInput[];
  readonly typed_fact_frame_gap?: TypedFactFrameCopyGap;
  readonly evidence_ids?: readonly string[];
  readonly polarity?: NamedPolarityReceipt;
  readonly relation_validity?: NamedRelationValidityReceipt;
  readonly supersession?: NamedSupersessionReceipt;
  readonly contradiction?: NamedContradictionReceipt;
}>;

export type CandidatePropositionProvenanceInput = Readonly<{
  readonly candidate_keys: readonly string[];
  readonly query_osf_formation?: QueryOsfFormationView | null;
  readonly query_osf_completeness?: QueryOsfCompletenessView | null;
  readonly open_semantic_factor_composition?: CompositionView | null;
  readonly candidates?: readonly CandidatePropositionProvenanceCandidateInput[];
}>;

type TypedFactFrameCopy = TypedFactFrameReceiptInput;

type CandidateOsfProvenance = Readonly<{
  readonly status: "certified" | "unavailable";
  readonly reason: ProvenanceUnavailableReason | null;
  readonly formation_status: QueryOsfFormationView["status"] | "absent";
  readonly completeness_present: boolean;
  readonly composition_status: OpenSemanticFactorCompositionStatus | "absent";
  readonly producer_operator_id: string | null;
  readonly bindings: ProvenanceCoordinate<readonly OsfBindingView[]>;
}>;

export type CandidatePropositionProvenance = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: typeof CANDIDATE_PROPOSITION_PROVENANCE_OPERATOR_ID;
  readonly candidate_key: string;
  readonly osf: CandidateOsfProvenance;
  readonly typed_fact_frames: ProvenanceCoordinate<readonly TypedFactFrameCopy[]>;
  readonly evidence_links: ProvenanceCoordinate<readonly string[]>;
  readonly polarity: ProvenanceCoordinate<NamedPolarityReceipt>;
  readonly relation_validity: ProvenanceCoordinate<NamedRelationValidityReceipt>;
  readonly supersession: ProvenanceCoordinate<NamedSupersessionReceipt>;
  readonly contradiction: ProvenanceCoordinate<NamedContradictionReceipt>;
}>;

export type CandidatePropositionProvenanceMap =
  Readonly<Record<string, CandidatePropositionProvenance>>;

export class DuplicateCandidateProvenanceKeyError extends Error {
  public constructor(candidateKey: string) {
    super(`duplicate candidate provenance key: ${candidateKey}`);
    this.name = "DuplicateCandidateProvenanceKeyError";
  }
}

// invariant: missing named proof is unavailable; an empty list is not known-zero.
export function collateCandidatePropositionProvenance(
  input: CandidatePropositionProvenanceInput
): CandidatePropositionProvenanceMap {
  const details = indexCandidates(input.candidates ?? []);
  const rows: Record<string, CandidatePropositionProvenance> = {};
  for (const candidateKey of input.candidate_keys) {
    if (candidateKey.length === 0) continue;
    if (Object.prototype.hasOwnProperty.call(rows, candidateKey)) {
      throw new DuplicateCandidateProvenanceKeyError(candidateKey);
    }
    rows[candidateKey] = collateOne(candidateKey, details.get(candidateKey), input);
  }
  return Object.freeze(rows);
}

function collateOne(
  candidateKey: string,
  details: CandidatePropositionProvenanceCandidateInput | undefined,
  input: CandidatePropositionProvenanceInput
): CandidatePropositionProvenance {
  const evidenceIds = details?.evidence_ids ?? [];
  return Object.freeze({
    schema_version: 1 as const,
    operator_id: CANDIDATE_PROPOSITION_PROVENANCE_OPERATOR_ID,
    candidate_key: candidateKey,
    osf: collateOsf(input, evidenceIds),
    typed_fact_frames: collateTypedFactFrames(details),
    evidence_links: collateEvidenceLinks(evidenceIds),
    polarity: collatePolarity(details?.polarity),
    relation_validity: collateRelationValidity(details?.relation_validity),
    supersession: collateSupersession(details?.supersession),
    contradiction: collateContradiction(details?.contradiction)
  });
}

function collateOsf(
  input: CandidatePropositionProvenanceInput,
  evidenceIds: readonly string[]
): CandidateOsfProvenance {
  const formation = input.query_osf_formation ?? null;
  const completeness = input.query_osf_completeness ?? null;
  const queryReason = certifiedOsfReason(formation, completeness);
  const bindings = collateOsfBindings(
    queryReason === null,
    queryReason,
    input.open_semantic_factor_composition ?? null,
    evidenceIds
  );
  // invariant: query certification does not certify a candidate without attributed bindings.
  return Object.freeze({
    status: bindings.status === "available" ? "certified" as const : "unavailable" as const,
    reason: bindings.status === "available" ? null : bindings.reason,
    formation_status: formation?.status ?? "absent",
    completeness_present: completeness !== null,
    composition_status: input.open_semantic_factor_composition?.status ?? "absent",
    producer_operator_id: formation?.producer_operator_id ?? null,
    bindings
  });
}

function certifiedOsfReason(
  formation: QueryOsfFormationView | null,
  completeness: QueryOsfCompletenessView | null
): ProvenanceUnavailableReason | null {
  if (completeness === null) return "certified_osf_receipt_absent";
  if (completeness.query_producer_operator_id !== QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID) {
    return "certified_osf_producer_mismatch";
  }
  if (formation?.producer_operator_id != null &&
      formation.producer_operator_id !== QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID) {
    return "certified_osf_producer_mismatch";
  }
  if (formation?.status !== "formed" ||
      formation.producer_operator_id !== QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID) {
    return "osf_formation_not_formed";
  }
  return null;
}

function collateOsfBindings(
  queryCertified: boolean,
  queryReason: ProvenanceUnavailableReason | null,
  composition: CompositionView | null,
  evidenceIds: readonly string[]
): ProvenanceCoordinate<readonly OsfBindingView[]> {
  if (!queryCertified) return unavailable(queryReason ?? "certified_osf_receipt_absent");
  if (composition === null) return unavailable("osf_composition_absent");
  // invariant: missing or true truncated cannot prove a complete binding set.
  if (composition.truncated !== false) return unavailable("osf_composition_truncated");
  if (composition.status !== "composed") return unavailable("osf_composition_not_composed");
  const allowed = new Set(evidenceIds.filter((id) => id.length > 0));
  const copied = Object.freeze((composition.bindings ?? [])
    .filter((binding) => allowed.has(binding.evidence_id))
    .map(copyBinding));
  return copied.length > 0 ? available(copied) : unavailable("osf_binding_not_attributed");
}

function collateTypedFactFrames(
  details: CandidatePropositionProvenanceCandidateInput | undefined
): ProvenanceCoordinate<readonly TypedFactFrameCopy[]> {
  const frames = details?.typed_fact_frames;
  if (frames === undefined || frames.length === 0) {
    return unavailable(details?.typed_fact_frame_gap ?? "typed_fact_frame_receipt_absent");
  }
  const kept: TypedFactFrameCopy[] = [];
  let sawContentOwned = false;
  let sawMissingProducer = false;
  let sawDenied = false;
  for (const frame of frames) {
    if (isContentOwnedFrame(frame)) {
      sawContentOwned = true;
      continue;
    }
    const producer = frame.capture.producer_operator_id?.trim() ?? "";
    if (producer.length === 0) {
      sawMissingProducer = true;
      continue;
    }
    if (producer === RULE_BASED_QUERY_FACT_FRAME_OPERATOR_ID) {
      sawDenied = true;
      continue;
    }
    kept.push(copyTypedFrame(frame));
  }
  if (kept.length > 0) return available(Object.freeze(kept));
  if (sawDenied) return unavailable("typed_fact_frame_query_producer_denied");
  if (sawContentOwned) return unavailable("content_owned_excluded");
  if (sawMissingProducer) return unavailable("typed_fact_frame_producer_absent");
  return unavailable(details?.typed_fact_frame_gap ?? "typed_fact_frame_receipt_absent");
}

function collateEvidenceLinks(
  evidenceIds: readonly string[]
): ProvenanceCoordinate<readonly string[]> {
  const copied = Object.freeze([...new Set(evidenceIds.filter((id) => id.length > 0))]);
  return copied.length > 0 ? available(copied) : unavailable("evidence_link_absent");
}

function collatePolarity(
  receipt: NamedPolarityReceipt | undefined
): ProvenanceCoordinate<NamedPolarityReceipt> {
  if (receipt === undefined || !hasProducer(receipt.producer_operator_id) ||
      (receipt.polarity !== "positive" && receipt.polarity !== "negative")) {
    return unavailable("polarity_receipt_absent");
  }
  return available(Object.freeze({
    producer_operator_id: receipt.producer_operator_id,
    polarity: receipt.polarity
  }));
}

function collateRelationValidity(
  receipt: NamedRelationValidityReceipt | undefined
): ProvenanceCoordinate<NamedRelationValidityReceipt> {
  if (receipt === undefined || !hasProducer(receipt.producer_operator_id) ||
      (receipt.validity !== "active" && receipt.validity !== "expired" &&
        receipt.validity !== "unknown")) {
    return unavailable("relation_validity_receipt_absent");
  }
  return available(Object.freeze({
    producer_operator_id: receipt.producer_operator_id,
    validity: receipt.validity
  }));
}

function collateSupersession(
  receipt: NamedSupersessionReceipt | undefined
): ProvenanceCoordinate<NamedSupersessionReceipt> {
  if (receipt === undefined || !hasProducer(receipt.producer_operator_id) ||
      (receipt.standing !== "current" && receipt.standing !== "superseded")) {
    return unavailable("supersession_receipt_absent");
  }
  return available(Object.freeze({
    producer_operator_id: receipt.producer_operator_id,
    standing: receipt.standing,
    ...(receipt.superseding_assertion_id === undefined
      ? {}
      : { superseding_assertion_id: receipt.superseding_assertion_id })
  }));
}

function collateContradiction(
  receipt: NamedContradictionReceipt | undefined
): ProvenanceCoordinate<NamedContradictionReceipt> {
  if (receipt === undefined || !hasProducer(receipt.producer_operator_id) ||
      (receipt.standing !== "contradicted" && receipt.standing !== "contradicting")) {
    return unavailable("contradiction_receipt_absent");
  }
  return available(Object.freeze({
    producer_operator_id: receipt.producer_operator_id,
    standing: receipt.standing,
    ...(receipt.counterpart_id === undefined ? {} : { counterpart_id: receipt.counterpart_id })
  }));
}

function isContentOwnedFrame(frame: TypedFactFrameReceiptInput): boolean {
  if (frame.capture.producer_operator_id === CONTENT_OWNED_ASSERTION_FACT_KEY_OPERATOR_ID) {
    return true;
  }
  const slots = frame.capture.fact_frame?.slots ?? [];
  return slots.length === 1 && slots[0]?.role === "value";
}

function copyTypedFrame(frame: TypedFactFrameReceiptInput): TypedFactFrameCopy {
  return Object.freeze({
    capture: frame.capture,
    evidence_id: frame.evidence_id
  });
}

function copyBinding(binding: OsfBindingView): OsfBindingView {
  return Object.freeze({
    variable_id: binding.variable_id,
    binding_identity: binding.binding_identity,
    semantic_identity: binding.semantic_identity,
    evidence_id: binding.evidence_id,
    ...(binding.query_proposition_id === undefined
      ? {}
      : { query_proposition_id: binding.query_proposition_id }),
    ...(binding.evidence_proposition_id === undefined
      ? {}
      : { evidence_proposition_id: binding.evidence_proposition_id })
  });
}

function indexCandidates(
  rows: readonly CandidatePropositionProvenanceCandidateInput[]
): ReadonlyMap<string, CandidatePropositionProvenanceCandidateInput> {
  const indexed = new Map<string, CandidatePropositionProvenanceCandidateInput>();
  for (const row of rows) {
    if (indexed.has(row.candidate_key)) {
      throw new DuplicateCandidateProvenanceKeyError(row.candidate_key);
    }
    indexed.set(row.candidate_key, row);
  }
  return indexed;
}

function hasProducer(producerOperatorId: string): boolean {
  return producerOperatorId.trim().length > 0;
}

function available<T>(value: T): ProvenanceCoordinate<T> {
  return Object.freeze({ status: "available" as const, value });
}

function unavailable(
  reason: ProvenanceUnavailableReason
): ProvenanceCoordinate<never> {
  return Object.freeze({ status: "unavailable" as const, reason });
}
