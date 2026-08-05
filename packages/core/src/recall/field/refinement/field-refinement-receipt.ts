import type { FtsLaneId } from "@do-soul/alaya-protocol";

import { buildRecallCandidateDedupeKey } from
  "../../runtime/recall-service-helpers.js";
import type {
  KeywordSearchFieldRefinementLevel,
  KeywordSearchFieldResult,
  KeywordSearchLaneObservation,
  KeywordSearchLaneReceipt
} from "../../runtime/recall-service-types.js";
import { digestRecallFieldIdentity, type RecallFieldDigest } from
  "../field-identity.js";

export const RECALL_RETRIEVAL_FIELD_REFINEMENT_OPERATOR_ID =
  "recall_retrieval_field_refinement_v1";
export const RECALL_FIELD_PREFIX_ORDERING_OPERATOR_ID =
  "ordered_object_source_prefix_v1";
export const RECALL_FIELD_SCORE_CALIBRATION_OPERATOR_ID =
  "grouped_ordinal_rank_v1";

export type RecallFieldScoreRecalibration = Readonly<{
  readonly observation_id: string;
  readonly from: number;
  readonly to: number;
}>;

export type RecallFieldRefinementLevelReceipt = Readonly<{
  readonly requested_depth: number;
  readonly status: KeywordSearchLaneReceipt["status"];
  readonly observed_depth: number;
  readonly new_observation_ids: readonly string[];
  readonly score_recalibrations: readonly RecallFieldScoreRecalibration[];
  readonly unseen_upper_bound: number | null;
}>;

export type RecallFieldLaneRefinementReceipt = Readonly<{
  readonly lane: FtsLaneId;
  readonly levels: readonly Readonly<RecallFieldRefinementLevelReceipt>[];
}>;

export type RecallRetrievalFieldRefinementReceipt = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: typeof RECALL_RETRIEVAL_FIELD_REFINEMENT_OPERATOR_ID;
  readonly activation_mode: "shadow";
  readonly ordering_operator_id: typeof RECALL_FIELD_PREFIX_ORDERING_OPERATOR_ID;
  readonly score_calibration_operator_id:
    typeof RECALL_FIELD_SCORE_CALIBRATION_OPERATOR_ID;
  readonly request_digest: RecallFieldDigest;
  readonly source_snapshot_digest: RecallFieldDigest;
  readonly requested_depths: readonly number[];
  readonly lanes: readonly Readonly<RecallFieldLaneRefinementReceipt>[];
  readonly stop_reason:
    | "all_channels_closed"
    | "observation_budget_exhausted"
    | "source_unavailable";
  readonly candidate_membership_changed: false;
  readonly receipt_digest: RecallFieldDigest;
}>;

export function createRecallRetrievalFieldRefinementReceipt(params: Readonly<{
  readonly request_digest: RecallFieldDigest;
  readonly requested_depth: number;
  readonly object_kind: "memory_entry" | "evidence_capsule" | "synthesis_capsule";
  readonly result: Readonly<KeywordSearchFieldResult>;
}>): RecallRetrievalFieldRefinementReceipt | null {
  const views = refinementViews(params.requested_depth, params.result);
  if (views.every(({ lanes }) => lanes.every(({ status }) => status === "unavailable"))) {
    return null;
  }
  const sourceSnapshotDigest = digestRecallFieldIdentity({
    producer: "request_scoped_keyword_field_observation_v1",
    request_digest: params.request_digest,
    views
  });
  const body = Object.freeze({
    schema_version: 1 as const,
    operator_id: RECALL_RETRIEVAL_FIELD_REFINEMENT_OPERATOR_ID,
    activation_mode: "shadow" as const,
    ordering_operator_id: RECALL_FIELD_PREFIX_ORDERING_OPERATOR_ID,
    score_calibration_operator_id: RECALL_FIELD_SCORE_CALIBRATION_OPERATOR_ID,
    request_digest: params.request_digest,
    source_snapshot_digest: sourceSnapshotDigest,
    requested_depths: Object.freeze(views.map(({ requested_depth }) => requested_depth)),
    lanes: materializeLaneReceipts(params, views),
    stop_reason: resolveStopReason(views.at(-1)!.lanes),
    candidate_membership_changed: false as const
  });
  return Object.freeze({
    ...body,
    receipt_digest: digestRecallFieldIdentity(body)
  });
}

export function verifyRecallRetrievalFieldRefinementReceipt(
  receipt: Readonly<RecallRetrievalFieldRefinementReceipt>
): void {
  if (receipt.schema_version !== 1 ||
      receipt.operator_id !== RECALL_RETRIEVAL_FIELD_REFINEMENT_OPERATOR_ID ||
      receipt.activation_mode !== "shadow" ||
      receipt.ordering_operator_id !== RECALL_FIELD_PREFIX_ORDERING_OPERATOR_ID ||
      receipt.score_calibration_operator_id !==
        RECALL_FIELD_SCORE_CALIBRATION_OPERATOR_ID ||
      receipt.candidate_membership_changed !== false ||
      receipt.receipt_digest !== digestRecallFieldIdentity(receiptBody(receipt))) {
    throw new Error("retrieval field refinement receipt fidelity mismatch");
  }
  assertReceiptStructure(receipt);
}

function assertReceiptStructure(
  receipt: Readonly<RecallRetrievalFieldRefinementReceipt>
): void {
  assertDigest(receipt.request_digest);
  assertDigest(receipt.source_snapshot_digest);
  assertIncreasingDepths(receipt.requested_depths);
  if (receipt.lanes.length !== 3 ||
      receipt.lanes.some((lane, index) =>
        lane.lane !== (["exact", "porter", "trigram"] as const)[index] ||
        lane.levels.length !== receipt.requested_depths.length)) {
    throw new Error("retrieval field refinement lane catalog mismatch");
  }
  receipt.lanes.forEach((lane) => assertLaneLevels(lane, receipt.requested_depths));
  const finalLanes = receipt.lanes.map(({ levels }) => levels.at(-1)!);
  if (resolveStopReason(finalLanes) !== receipt.stop_reason) {
    throw new Error("retrieval field refinement stop reason mismatch");
  }
}

function assertLaneLevels(
  lane: Readonly<RecallFieldLaneRefinementReceipt>,
  depths: readonly number[]
): void {
  let previous: Readonly<RecallFieldRefinementLevelReceipt> | undefined;
  lane.levels.forEach((level, index) => {
    if (level.requested_depth !== depths[index] ||
        !Number.isSafeInteger(level.observed_depth) || level.observed_depth < 0 ||
        level.observed_depth > level.requested_depth ||
        !validLevelBound(level.status, level.unseen_upper_bound) ||
        new Set(level.new_observation_ids).size !== level.new_observation_ids.length ||
        level.new_observation_ids.some((identity) => identity.trim().length === 0)) {
      throw new Error("retrieval field refinement level shape mismatch");
    }
    assertLevelTransition(previous, level);
    level.score_recalibrations.forEach(assertScoreRecalibration);
    previous = level;
  });
}

function assertLevelTransition(
  previous: Readonly<RecallFieldRefinementLevelReceipt> | undefined,
  level: Readonly<RecallFieldRefinementLevelReceipt>
): void {
  if (level.status === "complete" && level.unseen_upper_bound !== 0) {
    throw new Error("complete refinement level must close its unseen bound");
  }
  if ((level.status === "unavailable" || level.status === "ineligible") &&
      level.observed_depth !== 0) {
    throw new Error("closed empty refinement level contains observations");
  }
  if (previous === undefined) return;
  const invalidTruncatedTransition = previous.status === "truncated" &&
    level.status !== "truncated" && level.status !== "complete";
  if (level.observed_depth < previous.observed_depth ||
      (level.unseen_upper_bound !== null && previous.unseen_upper_bound !== null &&
        level.unseen_upper_bound > previous.unseen_upper_bound) ||
      invalidTruncatedTransition ||
      (previous.status !== "truncated" && previous.status !== level.status)) {
    throw new Error("retrieval field refinement level is not monotone");
  }
}

function validLevelBound(
  status: KeywordSearchLaneReceipt["status"],
  value: number | null
): boolean {
  if (status === "unavailable" || status === "ineligible") return value === null;
  return value !== null && unitInterval(value);
}

function assertScoreRecalibration(value: Readonly<RecallFieldScoreRecalibration>): void {
  if (value.observation_id.trim().length === 0 ||
      !unitInterval(value.from) || !unitInterval(value.to) || value.from === value.to) {
    throw new Error("retrieval field score recalibration is invalid");
  }
}

function assertIncreasingDepths(depths: readonly number[]): void {
  if (depths.length === 0 || depths.some((depth, index) =>
    !Number.isSafeInteger(depth) || depth <= 0 ||
    (index > 0 && depth <= depths[index - 1]!))) {
    throw new Error("retrieval field refinement depths are not increasing");
  }
}

function assertDigest(value: string): void {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new Error("retrieval field refinement digest is invalid");
  }
}

function unitInterval(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function refinementViews(
  requestedDepth: number,
  result: Readonly<KeywordSearchFieldResult>
): readonly Readonly<KeywordSearchFieldRefinementLevel>[] {
  return Object.freeze([
    Object.freeze({
      requested_depth: requestedDepth,
      matches: result.matches,
      lanes: result.lanes
    }),
    ...(result.refinement_levels ?? [])
  ]);
}

function materializeLaneReceipts(
  params: Parameters<typeof createRecallRetrievalFieldRefinementReceipt>[0],
  views: readonly Readonly<KeywordSearchFieldRefinementLevel>[]
): readonly Readonly<RecallFieldLaneRefinementReceipt>[] {
  return Object.freeze(views[0]!.lanes.map((initialLane, laneIndex) => {
    let previous: Readonly<KeywordSearchLaneReceipt> | undefined;
    const levels = views.map((view) => {
      const lane = view.lanes[laneIndex]!;
      const level = materializeLevel(params, view.requested_depth, lane, previous);
      previous = lane;
      return level;
    });
    return Object.freeze({ lane: initialLane.lane, levels: Object.freeze(levels) });
  }));
}

function materializeLevel(
  params: Parameters<typeof createRecallRetrievalFieldRefinementReceipt>[0],
  requestedDepth: number,
  lane: Readonly<KeywordSearchLaneReceipt>,
  previous: Readonly<KeywordSearchLaneReceipt> | undefined
): RecallFieldRefinementLevelReceipt {
  const previousDepth = previous?.observations.length ?? 0;
  return Object.freeze({
    requested_depth: requestedDepth,
    status: lane.status,
    observed_depth: lane.depth,
    new_observation_ids: Object.freeze(lane.observations.slice(previousDepth).map((observation) =>
      observationId(params.request_digest, params.object_kind, lane.lane, observation)
    )),
    score_recalibrations: Object.freeze(previous === undefined
      ? []
      : scoreRecalibrations(params.request_digest, params.object_kind, lane, previous)),
    unseen_upper_bound: lane.unseen_upper_bound
  });
}

function scoreRecalibrations(
  requestDigest: RecallFieldDigest,
  objectKind: Parameters<typeof createRecallRetrievalFieldRefinementReceipt>[0]["object_kind"],
  lane: Readonly<KeywordSearchLaneReceipt>,
  previous: Readonly<KeywordSearchLaneReceipt>
): readonly RecallFieldScoreRecalibration[] {
  return previous.observations.flatMap((observation, index) => {
    const next = lane.observations[index]!;
    return observation.normalized_rank === next.normalized_rank ? [] : [Object.freeze({
      observation_id: observationId(requestDigest, objectKind, lane.lane, next),
      from: observation.normalized_rank,
      to: next.normalized_rank
    })];
  });
}

function observationId(
  requestDigest: RecallFieldDigest,
  objectKind: Parameters<typeof createRecallRetrievalFieldRefinementReceipt>[0]["object_kind"],
  lane: FtsLaneId,
  observation: Readonly<KeywordSearchLaneObservation>
): string {
  const candidateKey = buildRecallCandidateDedupeKey({
    entry: { object_id: observation.object_id },
    objectKind
  });
  return `${lane}:${requestDigest}:${observation.source_id ?? candidateKey}:${observation.rank}`;
}

function resolveStopReason(
  lanes: readonly Readonly<Pick<KeywordSearchLaneReceipt, "status">>[]
): RecallRetrievalFieldRefinementReceipt["stop_reason"] {
  if (lanes.some(({ status }) => status === "truncated")) {
    return "observation_budget_exhausted";
  }
  if (lanes.some(({ status }) => status === "unavailable")) return "source_unavailable";
  return "all_channels_closed";
}

function receiptBody(receipt: Readonly<RecallRetrievalFieldRefinementReceipt>) {
  const { receipt_digest: _digest, ...body } = receipt;
  return body;
}
