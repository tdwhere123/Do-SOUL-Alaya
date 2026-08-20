import { createHash } from "node:crypto";
import {
  OpenSemanticFactorCandidateActivationsSchema,
  type OpenSemanticFactorCandidateActivationEntry
} from "../../schema/field/open-semantic-candidate-activation-schema.js";
import {
  PRODUCT_PHASES,
  type ProductPhaseLedger
} from "../../phase/phase-authority.js";

export const CACHED_F3_EXPOSURE_POLICY = {
  schema_version: 2 as const,
  kind: "cached_f3_exposed_denominator_policy" as const,
  declared_minimum_rate: 1,
  candidate_attribution_required: true,
  control_non_exposure_required: true
};
export type TreatmentExposureStatus = "exposed" | "not_exercised" | "inconclusive";
export type TreatmentExposureStage = "S0" | "S1" | "S2" | "S3" | "S4" | "S5";
export type TreatmentFormationStatus = "formed" | "ineligible" | "unavailable" | "rejected" | null;
export type TreatmentCompositionStatus = "composed" | "no_match" | "ineligible" | "unavailable" | "rejected" | null;
type RetrievalChannelStatus = "complete" | "truncated" | "unavailable" | "ineligible";

export interface ControlNonExposureWitness {
  readonly observed: boolean;
  readonly formation_status: TreatmentFormationStatus;
  readonly compatible_count: number;
  readonly composition_status: TreatmentCompositionStatus;
  readonly activation_status: TreatmentCompositionStatus;
  readonly activated_evidence_count: number;
  readonly candidate_attribution_count: number;
  readonly pure: boolean;
}

interface TreatmentExposureMembershipDelta {
  readonly observed: boolean;
  readonly changed: boolean;
  readonly added_candidate_keys: readonly string[];
  readonly removed_candidate_keys: readonly string[];
}

interface TreatmentExposureCandidatePool {
  readonly control_complete: boolean | null;
  readonly treatment_complete: boolean;
}

interface TreatmentExposureQueryProbeDelta {
  readonly observed: boolean;
  readonly changed: boolean;
  readonly added_expanded_terms: readonly string[];
  readonly removed_expanded_terms: readonly string[];
}

interface TreatmentExposureChannelChange {
  readonly channel_id: string;
  readonly control_status: RetrievalChannelStatus | null;
  readonly treatment_status: RetrievalChannelStatus | null;
  readonly control_depth: number | null;
  readonly treatment_depth: number | null;
}

interface TreatmentExposureRetrievalChannelDelta {
  readonly observed: boolean;
  readonly changed: boolean;
  readonly changed_channels: readonly TreatmentExposureChannelChange[];
}

export interface TreatmentExposureReceiptBody {
  readonly schema_version: 4;
  readonly kind: "cached_f3_treatment_exposure";
  readonly question_id: string;
  readonly evidence_chain: { readonly linked: boolean };
  readonly control_non_exposure: ControlNonExposureWitness;
  readonly formation: { readonly status: TreatmentFormationStatus };
  readonly compatible_evidence: { readonly compatible_count: number };
  readonly composition: { readonly status: TreatmentCompositionStatus; readonly solution_count: number; readonly binding_count: number };
  readonly activation: { readonly status: TreatmentCompositionStatus; readonly activated_evidence_count: number };
  readonly candidate_attribution: {
    readonly entries: readonly OpenSemanticFactorCandidateActivationEntry[];
    readonly candidate_keys: readonly string[];
    readonly activated_evidence_ids: readonly string[];
  };
  readonly membership_delta: TreatmentExposureMembershipDelta;
  readonly candidate_pool: TreatmentExposureCandidatePool;
  readonly query_probe_delta: TreatmentExposureQueryProbeDelta;
  readonly retrieval_channel_delta: TreatmentExposureRetrievalChannelDelta;
  readonly outcome: {
    readonly control: { readonly stage: TreatmentExposureStage; readonly hit_at_5: boolean };
    readonly treatment: { readonly stage: TreatmentExposureStage; readonly hit_at_5: boolean };
  };
  readonly product_phase_ledger: ProductPhaseLedger;
  readonly exposure_status: TreatmentExposureStatus;
}
export interface TreatmentExposureReceipt extends TreatmentExposureReceiptBody {
  readonly receipt_digest: string;
}

export function sealTreatmentExposureReceipt(body: TreatmentExposureReceiptBody): TreatmentExposureReceipt {
  return { ...body, receipt_digest: receiptDigest(body) };
}

export function assertTreatmentExposureReceipt(value: unknown): asserts value is TreatmentExposureReceipt {
  if (!isReceiptShape(value)) throw invalidReceipt();
  const { receipt_digest: actual, ...body } = value;
  if (actual !== receiptDigest(body) || !isReceiptConsistent(value)) throw invalidReceipt(value.question_id);
}

export function deriveTreatmentExposureStatus(receipt: TreatmentExposureReceiptBody): TreatmentExposureStatus {
  if (!receipt.control_non_exposure.observed || !receipt.control_non_exposure.pure ||
      !receipt.evidence_chain.linked) return "inconclusive";
  return hasCompleteExposure(receipt) ? "exposed" : "not_exercised";
}

export function deriveControlPurity(witness: ControlNonExposureWitness): boolean {
  return witness.formation_status !== "formed" && witness.compatible_count === 0 &&
    witness.composition_status !== "composed" && witness.activation_status !== "composed" &&
    witness.activated_evidence_count === 0 && witness.candidate_attribution_count === 0;
}

function isReceiptConsistent(receipt: TreatmentExposureReceipt): boolean {
  if (receipt.evidence_chain.linked && (receipt.formation.status === null ||
      receipt.composition.status === null || receipt.activation.status === null)) return false;
  if (receipt.compatible_evidence.compatible_count > 0 && receipt.formation.status !== "formed") return false;
  return isControlValid(receipt.control_non_exposure) &&
    isCandidateAttributionValid(receipt.candidate_attribution) &&
    isObservedDeltaValid(receipt.membership_delta, receipt.membership_delta.added_candidate_keys,
      receipt.membership_delta.removed_candidate_keys) &&
    isObservedDeltaValid(receipt.query_probe_delta, receipt.query_probe_delta.added_expanded_terms,
      receipt.query_probe_delta.removed_expanded_terms) &&
    isRetrievalChannelDeltaValid(receipt.retrieval_channel_delta) &&
    isCandidatePoolValid(receipt) &&
    isOutcomeValid(receipt) && isPhaseLedger(receipt.product_phase_ledger) &&
    receipt.exposure_status === deriveTreatmentExposureStatus(receipt);
}

function isReceiptShape(value: unknown): value is TreatmentExposureReceipt {
  if (!isRecord(value) || !hasExactKeys(value, [
    "schema_version", "kind", "question_id", "evidence_chain", "control_non_exposure",
    "formation", "compatible_evidence", "composition", "activation", "candidate_attribution",
    "membership_delta", "candidate_pool", "query_probe_delta", "retrieval_channel_delta",
    "outcome", "product_phase_ledger", "exposure_status", "receipt_digest"
  ])) return false;
  return value.schema_version === 4 && value.kind === "cached_f3_treatment_exposure" &&
    isNonEmptyString(value.question_id) && isDigest(value.receipt_digest) &&
    isBooleanBox(value.evidence_chain, "linked") && isControlWitness(value.control_non_exposure) &&
    isStatusBox(value.formation, true) && isCountBox(value.compatible_evidence, "compatible_count") &&
    isComposition(value.composition) && isActivation(value.activation) &&
    isCandidateAttribution(value.candidate_attribution) && isMembership(value.membership_delta) &&
    isCandidatePool(value.candidate_pool) && isQueryProbeDelta(value.query_probe_delta) &&
    isRetrievalChannelDelta(value.retrieval_channel_delta) &&
    isOutcome(value.outcome) && isPhaseLedger(value.product_phase_ledger) &&
    isExposureStatus(value.exposure_status);
}

function isControlWitness(value: unknown): value is ControlNonExposureWitness {
  return isRecord(value) && hasExactKeys(value, ["observed", "formation_status", "compatible_count",
    "composition_status", "activation_status", "activated_evidence_count",
    "candidate_attribution_count", "pure"]) && typeof value.observed === "boolean" &&
    isFormationStatus(value.formation_status) && isCount(value.compatible_count) &&
    isCompositionStatus(value.composition_status) && isCompositionStatus(value.activation_status) &&
    isCount(value.activated_evidence_count) && isCount(value.candidate_attribution_count) &&
    typeof value.pure === "boolean";
}

function isControlValid(value: ControlNonExposureWitness): boolean {
  return value.pure === deriveControlPurity(value) && (value.observed || value.candidate_attribution_count === 0);
}

function isCandidateAttribution(value: unknown): value is TreatmentExposureReceipt["candidate_attribution"] {
  return isRecord(value) && hasExactKeys(value, ["entries", "candidate_keys", "activated_evidence_ids"]) &&
    OpenSemanticFactorCandidateActivationsSchema.safeParse(value.entries).success &&
    isSortedUniqueStrings(value.candidate_keys) && isSortedUniqueStrings(value.activated_evidence_ids);
}

function isCandidateAttributionValid(value: TreatmentExposureReceipt["candidate_attribution"]): boolean {
  const keys = value.entries.map((entry) => entry.candidate_key);
  const evidence = [...new Set(value.entries.flatMap((entry) => entry.receipt.evidence_ids))].sort();
  return arraysEqual(keys, value.candidate_keys) && arraysEqual(evidence, value.activated_evidence_ids);
}

function isStatusBox(value: unknown, formation: boolean): boolean {
  return isRecord(value) && hasExactKeys(value, ["status"]) &&
    (formation ? isFormationStatus(value.status) : isCompositionStatus(value.status));
}
function isCountBox(value: unknown, key: string): boolean {
  return isRecord(value) && hasExactKeys(value, [key]) && isCount(value[key]);
}
function isBooleanBox(value: unknown, key: string): boolean {
  return isRecord(value) && hasExactKeys(value, [key]) && typeof value[key] === "boolean";
}
function isComposition(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ["status", "solution_count", "binding_count"]) &&
    isCompositionStatus(value.status) && isCount(value.solution_count) && isCount(value.binding_count);
}
function isActivation(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ["status", "activated_evidence_count"]) &&
    isCompositionStatus(value.status) && isCount(value.activated_evidence_count);
}
function isMembership(value: unknown): value is TreatmentExposureMembershipDelta {
  return isObservedStringDelta(value, "added_candidate_keys", "removed_candidate_keys");
}
function isCandidatePool(value: unknown): value is TreatmentExposureCandidatePool {
  return isRecord(value) && hasExactKeys(value, ["control_complete", "treatment_complete"]) &&
    (value.control_complete === null || typeof value.control_complete === "boolean") &&
    typeof value.treatment_complete === "boolean";
}
function isCandidatePoolValid(receipt: TreatmentExposureReceipt): boolean {
  return (receipt.candidate_pool.control_complete === null) ===
    !receipt.membership_delta.observed;
}
function isQueryProbeDelta(value: unknown): value is TreatmentExposureQueryProbeDelta {
  return isObservedStringDelta(value, "added_expanded_terms", "removed_expanded_terms");
}
function isObservedStringDelta(
  value: unknown,
  addedKey: string,
  removedKey: string
): value is { observed: boolean; changed: boolean; [key: string]: unknown } {
  return isRecord(value) && hasExactKeys(value, ["observed", "changed", addedKey, removedKey]) &&
    typeof value.observed === "boolean" && typeof value.changed === "boolean" &&
    isSortedUniqueStrings(value[addedKey]) && isSortedUniqueStrings(value[removedKey]);
}
function isRetrievalChannelDelta(value: unknown): value is TreatmentExposureRetrievalChannelDelta {
  return isRecord(value) && hasExactKeys(value, ["observed", "changed", "changed_channels"]) &&
    typeof value.observed === "boolean" && typeof value.changed === "boolean" &&
    isChangedChannels(value.changed_channels);
}
function isChangedChannels(value: unknown): value is readonly TreatmentExposureChannelChange[] {
  if (!Array.isArray(value) || !value.every(isChangedChannel)) return false;
  return isSortedUniqueStrings(value.map((entry) => entry.channel_id));
}
function isChangedChannel(value: unknown): value is TreatmentExposureChannelChange {
  return isRecord(value) && hasExactKeys(value, [
    "channel_id", "control_status", "treatment_status", "control_depth", "treatment_depth"
  ]) && isNonEmptyString(value.channel_id) && isChannelStatus(value.control_status) &&
    isChannelStatus(value.treatment_status) && isDepth(value.control_depth) && isDepth(value.treatment_depth);
}
function isOutcome(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ["control", "treatment"]) && isArmOutcome(value.control) && isArmOutcome(value.treatment);
}
function isArmOutcome(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ["stage", "hit_at_5"]) &&
    ["S0", "S1", "S2", "S3", "S4", "S5"].includes(value.stage as never) && typeof value.hit_at_5 === "boolean";
}

function isObservedDeltaValid(
  delta: { readonly observed: boolean; readonly changed: boolean },
  added: readonly string[],
  removed: readonly string[]
): boolean {
  const keys = [...added, ...removed];
  return delta.changed === (delta.observed && keys.length > 0) &&
    new Set(keys).size === keys.length && (delta.observed || keys.length === 0);
}
function isRetrievalChannelDeltaValid(delta: TreatmentExposureRetrievalChannelDelta): boolean {
  return delta.changed === (delta.observed && delta.changed_channels.length > 0) &&
    (delta.observed || delta.changed_channels.length === 0) &&
    delta.changed_channels.every((channel) =>
      channel.control_status !== channel.treatment_status ||
      channel.control_depth !== channel.treatment_depth);
}
function isOutcomeValid(receipt: TreatmentExposureReceipt): boolean {
  const changed = receipt.outcome.control.hit_at_5 !== receipt.outcome.treatment.hit_at_5;
  return !changed || receipt.membership_delta.changed;
}
function hasCompleteExposure(receipt: TreatmentExposureReceiptBody): boolean {
  return receipt.formation.status === "formed" && receipt.compatible_evidence.compatible_count > 0 &&
    receipt.composition.status === "composed" &&
    (receipt.composition.solution_count > 0 || receipt.composition.binding_count > 0) &&
    receipt.activation.status === "composed" && receipt.activation.activated_evidence_count > 0 &&
    receipt.candidate_attribution.entries.length > 0;
}
function isPhaseLedger(value: unknown): value is ProductPhaseLedger {
  if (!isRecord(value) || !hasExactKeys(value, PRODUCT_PHASES)) return false;
  return PRODUCT_PHASES.every((phase) => {
    const record = value[phase];
    return isRecord(record) && record.phase === phase &&
      (record.authority === "product" || record.authority === "diagnostic_only" ||
        record.authority === "not_observed");
  });
}

function isFormationStatus(value: unknown): value is TreatmentFormationStatus {
  return ["formed", "ineligible", "unavailable", "rejected", null].includes(value as never);
}
function isCompositionStatus(value: unknown): value is TreatmentCompositionStatus {
  return ["composed", "no_match", "ineligible", "unavailable", "rejected", null].includes(value as never);
}
function isExposureStatus(value: unknown): value is TreatmentExposureStatus {
  return value === "exposed" || value === "not_exercised" || value === "inconclusive";
}
function isChannelStatus(value: unknown): value is RetrievalChannelStatus | null {
  return value === null ||
    value === "complete" || value === "truncated" || value === "unavailable" || value === "ineligible";
}
function isDepth(value: unknown): value is number | null {
  return value === null || isCount(value);
}
function isSortedUniqueStrings(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isNonEmptyString) && value.every((entry, index) => index === 0 || value[index - 1]! < entry);
}
function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function receiptDigest(body: TreatmentExposureReceiptBody): string {
  return createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex");
}
function invalidReceipt(questionId = "unknown"): Error {
  return new Error(`invalid cached F3 treatment exposure receipt: ${questionId}`);
}
function isCount(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function isDigest(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value); }
function isNonEmptyString(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).length === keys.length && keys.every((key) => key in value); }
