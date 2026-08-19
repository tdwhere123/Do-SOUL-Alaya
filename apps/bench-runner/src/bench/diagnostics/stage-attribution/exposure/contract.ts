import { createHash } from "node:crypto";
import {
  OpenSemanticFactorCandidateActivationsSchema,
  type OpenSemanticFactorCandidateActivationEntry
} from "../../schema/field/open-semantic-candidate-activation-schema.js";

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

export interface TreatmentExposureReceiptBody {
  readonly schema_version: 3;
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
  readonly membership_delta: {
    readonly observed: boolean;
    readonly changed: boolean;
    readonly added_candidate_keys: readonly string[];
    readonly removed_candidate_keys: readonly string[];
  };
  readonly outcome: {
    readonly control: { readonly stage: TreatmentExposureStage; readonly hit_at_5: boolean };
    readonly treatment: { readonly stage: TreatmentExposureStage; readonly hit_at_5: boolean };
  };
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
    isCandidateAttributionValid(receipt.candidate_attribution) && isMembershipValid(receipt) &&
    isOutcomeValid(receipt) && receipt.exposure_status === deriveTreatmentExposureStatus(receipt);
}

function isReceiptShape(value: unknown): value is TreatmentExposureReceipt {
  if (!isRecord(value) || !hasExactKeys(value, [
    "schema_version", "kind", "question_id", "evidence_chain", "control_non_exposure",
    "formation", "compatible_evidence", "composition", "activation", "candidate_attribution",
    "membership_delta", "outcome", "exposure_status", "receipt_digest"
  ])) return false;
  return value.schema_version === 3 && value.kind === "cached_f3_treatment_exposure" &&
    isNonEmptyString(value.question_id) && isDigest(value.receipt_digest) &&
    isBooleanBox(value.evidence_chain, "linked") && isControlWitness(value.control_non_exposure) &&
    isStatusBox(value.formation, true) && isCountBox(value.compatible_evidence, "compatible_count") &&
    isComposition(value.composition) && isActivation(value.activation) &&
    isCandidateAttribution(value.candidate_attribution) && isMembership(value.membership_delta) &&
    isOutcome(value.outcome) && isExposureStatus(value.exposure_status);
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
function isMembership(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ["observed", "changed", "added_candidate_keys", "removed_candidate_keys"]) &&
    typeof value.observed === "boolean" && typeof value.changed === "boolean" &&
    isSortedUniqueStrings(value.added_candidate_keys) && isSortedUniqueStrings(value.removed_candidate_keys);
}
function isOutcome(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ["control", "treatment"]) && isArmOutcome(value.control) && isArmOutcome(value.treatment);
}
function isArmOutcome(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ["stage", "hit_at_5"]) &&
    ["S0", "S1", "S2", "S3", "S4", "S5"].includes(value.stage as never) && typeof value.hit_at_5 === "boolean";
}

function isMembershipValid(receipt: TreatmentExposureReceipt): boolean {
  const membership = receipt.membership_delta;
  const keys = [...membership.added_candidate_keys, ...membership.removed_candidate_keys];
  return membership.changed === (membership.observed && keys.length > 0) &&
    new Set(keys).size === keys.length && (membership.observed || keys.length === 0);
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
function isFormationStatus(value: unknown): value is TreatmentFormationStatus {
  return ["formed", "ineligible", "unavailable", "rejected", null].includes(value as never);
}
function isCompositionStatus(value: unknown): value is TreatmentCompositionStatus {
  return ["composed", "no_match", "ineligible", "unavailable", "rejected", null].includes(value as never);
}
function isExposureStatus(value: unknown): value is TreatmentExposureStatus {
  return value === "exposed" || value === "not_exercised" || value === "inconclusive";
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
