import type {
  RecallEvidenceSemanticActivationReceipt,
  RecallEvidenceSemanticWinnerReceipt
} from "../../../runtime/recall-service-types.js";
import type {
  SelectionBoundaryNumberMap,
  SerializedRecallSupplementaryData
} from "../selection-boundary-types.js";
import { isRecord } from "../record-guards.js";
import { throwSelectionBoundaryFidelityMismatch } from "./fidelity-error.js";

const FACT_SLOT_ROLES = new Set([
  "subject",
  "relation",
  "value",
  "qualifier",
  "time"
]);

export function assertEvidenceSemanticReceipts(
  data: SerializedRecallSupplementaryData
): void {
  if (data.evidenceSemanticActivationsByCandidateKey !== undefined) {
    if (data.evidenceSemanticScoresByCandidateKey !== undefined ||
        data.evidenceSemanticWinnersByCandidateKey !== undefined) {
      throwSelectionBoundaryFidelityMismatch(
        "expected exclusive evidence-semantic activation map, actual legacy winner or score map also present"
      );
    }
    for (const [, receipt] of data.evidenceSemanticActivationsByCandidateKey) {
      assertEvidenceSemanticActivation(receipt);
    }
    return;
  }
  assertLegacyEvidenceSemanticWinners(
    data.evidenceSemanticWinnersByCandidateKey,
    data.evidenceSemanticScoresByCandidateKey ?? []
  );
}

export function restoreSemanticActivations(
  activations: SerializedRecallSupplementaryData[
    "evidenceSemanticActivationsByCandidateKey"
  ],
  legacyWinners: SerializedRecallSupplementaryData[
    "evidenceSemanticWinnersByCandidateKey"
  ]
): ReadonlyMap<string, Readonly<RecallEvidenceSemanticActivationReceipt>> {
  if (activations !== undefined) return new Map(activations);
  return new Map((legacyWinners ?? []).map(([candidateKey, winner]) => [
    candidateKey,
    legacySemanticActivation(winner)
  ] as const));
}

function assertLegacyEvidenceSemanticWinners(
  entries: SerializedRecallSupplementaryData[
    "evidenceSemanticWinnersByCandidateKey"
  ],
  scoreEntries: SelectionBoundaryNumberMap
): void {
  if (entries === undefined) {
    if (scoreEntries.length !== 0) {
      throwSelectionBoundaryFidelityMismatch(
        `expected empty evidenceSemanticScoresByCandidateKey without winners, actual ${scoreEntries.length} scores`
      );
    }
    return;
  }
  if (entries.length !== scoreEntries.length) {
    throwSelectionBoundaryFidelityMismatch(
      `expected winner/score map lengths equal, actual winners=${entries.length} scores=${scoreEntries.length}`
    );
  }
  const scores = new Map(scoreEntries);
  for (const [candidateKey, winner] of entries) {
    const score = scores.get(candidateKey);
    if (score === undefined) {
      throwSelectionBoundaryFidelityMismatch(
        `expected score for each winner candidate, actual absent among ${scores.size} scores`
      );
    }
    assertEvidenceSemanticWinner(winner, score);
  }
}

function assertEvidenceSemanticActivation(receipt: unknown): void {
  if (!isRecord(receipt) || !hasReceiptHeader(receipt) ||
      !Array.isArray(receipt.observations) || receipt.observations.length === 0) {
    throwSelectionBoundaryFidelityMismatch(
      "expected evidence_document_max_v1 activation receipt, actual invalid header or empty observations"
    );
  }
  assertEvidenceSemanticWinner(receipt.winner, receipt.score as number);
  for (const observation of receipt.observations) {
    assertEvidenceSemanticWinner(observation);
  }
  const winner = receipt.winner as Record<string, unknown>;
  const observations = receipt.observations as Record<string, unknown>[];
  const matching = receipt.observations.filter((observation) =>
    isRecord(observation) && sameSemanticObservation(observation, winner)
  );
  if (matching.length !== 1 ||
      !sameSemanticObservation(receipt.observations[0] as Record<string, unknown>, winner) ||
      !semanticObservationsAreRanked(observations) ||
      (receipt.observation_completeness === "winner_only_legacy" &&
        receipt.observations.length !== 1)) {
    throwSelectionBoundaryFidelityMismatch(
      `expected ranked observations with one winner match, actual matches=${matching.length} observations=${receipt.observations.length}`
    );
  }
}

function hasReceiptHeader(receipt: Record<string, unknown>): boolean {
  return receipt.schema_version === 1 &&
    receipt.operator_id === "evidence_document_max_v1" &&
    receipt.state === "observed" &&
    isUnitNumber(receipt.score) &&
    receipt.missing_channel_policy === "no_op" &&
    (receipt.observation_completeness === "complete" ||
      receipt.observation_completeness === "bounded_candidate_prefix" ||
      receipt.observation_completeness === "winner_only_legacy");
}

function assertEvidenceSemanticWinner(winner: unknown, expectedScore?: number): void {
  if (!isRecord(winner) || !isUnitNumber(winner.score) ||
      (expectedScore !== undefined && expectedScore !== winner.score) ||
      !isNonEmptyString(winner.evidenceObjectId) ||
      !isNonEmptyString(winner.documentIdentity)) {
    throwSelectionBoundaryFidelityMismatch(
      expectedScore === undefined
        ? "expected unit-score evidence-semantic winner with identities, actual invalid"
        : `expected winner.score=${expectedScore}, actual ${String(
          isRecord(winner) ? winner.score : typeof winner
        )}`
    );
  }
  if (winner.projection === null) {
    if (winner.documentIdentity.startsWith("fact_key:")) {
      throwSelectionBoundaryFidelityMismatch(
        "expected null projection only for non-fact_key identity, actual fact_key prefix"
      );
    }
    return;
  }
  if (!isRecord(winner.projection)) {
    throwSelectionBoundaryFidelityMismatch(
      "expected object or null winner.projection, actual non-record"
    );
  }
  assertEvidenceSemanticProjection(winner.documentIdentity, winner.projection);
}

function assertEvidenceSemanticProjection(
  documentIdentity: string,
  projection: Record<string, unknown>
): void {
  const forms = projection.matched_fact_key_forms;
  if (!Array.isArray(forms) || forms.some((form) => !isFactKeyForm(form))) {
    throwSelectionBoundaryFidelityMismatch(
      "expected matched_fact_key_forms array of fact-key forms, actual invalid"
    );
  }
  const kind = projection.projection_kind;
  const id = projection.projection_id;
  const slots = projection.fact_slots;
  if (slots !== undefined && (!Array.isArray(slots) || !validFactSlots(slots))) {
    throwSelectionBoundaryFidelityMismatch(
      "expected valid fact_slots when present, actual invalid"
    );
  }
  const ownerValid = kind === "owner" && id === null && forms.length === 0 &&
    slots === undefined;
  const factKeyValid = kind === "fact_key" && Number.isInteger(id) &&
    (id as number) > 0 && documentIdentity === `fact_key:${String(id)}`;
  if (!ownerValid && !factKeyValid) {
    throwSelectionBoundaryFidelityMismatch(
      `expected owner or positive fact_key projection, actual kind=${String(kind)} id=${String(id)}`
    );
  }
}

function sameSemanticObservation(
  left: Record<string, unknown>,
  right: Record<string, unknown>
): boolean {
  return left.score === right.score &&
    left.evidenceObjectId === right.evidenceObjectId &&
    left.documentIdentity === right.documentIdentity &&
    sameSemanticProjection(left.projection, right.projection);
}

function sameSemanticProjection(left: unknown, right: unknown): boolean {
  if (left === null || right === null) return left === right;
  if (!isRecord(left) || !isRecord(right)) return false;
  if (left.projection_id !== right.projection_id ||
      left.projection_kind !== right.projection_kind ||
      !sameFactSlots(left.fact_slots, right.fact_slots)) return false;
  const leftForms = left.matched_fact_key_forms;
  const rightForms = right.matched_fact_key_forms;
  return Array.isArray(leftForms) && Array.isArray(rightForms) &&
    leftForms.length === rightForms.length &&
    leftForms.every((form, index) => sameFactKeyForm(form, rightForms[index]));
}

function validFactSlots(slots: readonly unknown[]): boolean {
  if (slots.length < 3 || slots.length > 6 || slots.some((slot) => !isFactSlot(slot))) {
    return false;
  }
  const roles = new Set(slots.map((slot) => (slot as Record<string, unknown>).role));
  return ["subject", "relation", "value"].every((role) => roles.has(role));
}

function isFactSlot(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 2 &&
    typeof value.text === "string" && value.text.length > 0 && value.text.length <= 512 &&
    typeof value.role === "string" && FACT_SLOT_ROLES.has(value.role);
}

function sameFactSlots(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  return Array.isArray(left) && Array.isArray(right) &&
    left.length === right.length && left.every((slot, index) =>
      isFactSlot(slot) && isFactSlot(right[index]) &&
      slot.role === right[index].role && slot.text === right[index].text
    );
}

function isFactKeyForm(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.kind === "complete") return Object.keys(value).length === 1;
  if (value.kind !== "leave_one_slot_out" || !isRecord(value.omitted_slot)) {
    return false;
  }
  const omitted = value.omitted_slot;
  return Object.keys(value).length === 2 && Object.keys(omitted).length === 2 &&
    Number.isInteger(omitted.slot_index) && (omitted.slot_index as number) >= 0 &&
    typeof omitted.role === "string" && FACT_SLOT_ROLES.has(omitted.role);
}

function sameFactKeyForm(left: unknown, right: unknown): boolean {
  if (!isFactKeyForm(left) || !isFactKeyForm(right)) return false;
  const leftForm = left as Record<string, unknown>;
  const rightForm = right as Record<string, unknown>;
  if (leftForm.kind !== rightForm.kind) return false;
  if (leftForm.kind === "complete") return true;
  const leftOmitted = leftForm.omitted_slot as Record<string, unknown>;
  const rightOmitted = rightForm.omitted_slot as Record<string, unknown>;
  return leftOmitted.slot_index === rightOmitted.slot_index &&
    leftOmitted.role === rightOmitted.role;
}

function semanticObservationsAreRanked(
  observations: readonly Record<string, unknown>[]
): boolean {
  const identities = new Set<string>();
  for (let index = 0; index < observations.length; index += 1) {
    const observation = observations[index]!;
    const identity = `${String(observation.evidenceObjectId)}\u0000${String(
      observation.documentIdentity
    )}`;
    if (identities.has(identity)) return false;
    identities.add(identity);
    if (index > 0 && compareSemanticObservations(
      observations[index - 1]!,
      observation
    ) > 0) return false;
  }
  return true;
}

function compareSemanticObservations(
  left: Record<string, unknown>,
  right: Record<string, unknown>
): number {
  const leftScore = left.score as number;
  const rightScore = right.score as number;
  if (leftScore !== rightScore) return rightScore - leftScore;
  const evidenceOrder = compareText(
    left.evidenceObjectId as string,
    right.evidenceObjectId as string
  );
  return evidenceOrder !== 0
    ? evidenceOrder
    : compareText(left.documentIdentity as string, right.documentIdentity as string);
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function legacySemanticActivation(
  winner: Readonly<RecallEvidenceSemanticWinnerReceipt>
): Readonly<RecallEvidenceSemanticActivationReceipt> {
  return Object.freeze({
    schema_version: 1,
    operator_id: "evidence_document_max_v1",
    state: "observed",
    score: winner.score,
    winner,
    observations: Object.freeze([winner]),
    observation_completeness: "winner_only_legacy",
    missing_channel_policy: "no_op"
  });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isUnitNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) &&
    value >= 0 && value <= 1;
}
