import { compareCodeUnits } from "@do-soul/alaya-protocol";
import type {
  KeywordLexicalMergeCapture,
  LexicalBoundCandidateProvenance,
  LexicalBoundLaneCapture,
  LexicalBoundLaneHit,
  LexicalBoundProducerReceipt
} from "../../runtime/recall-search-port-types.js";

const LANE_ORDER = Object.freeze([
  "exact", "porter", "object_key_porter", "trigram", "object_key_trigram"
] as const);
const LANE_PRIORITY = Object.freeze({
  exact: 0, porter: 1, object_key_porter: 1, trigram: 2, object_key_trigram: 2
} as const);

type ObservedRow = Readonly<{
  readonly lane: LexicalBoundLaneCapture;
  readonly row: LexicalBoundLaneCapture["rows"][number];
}>;
type Winner = Readonly<ObservedRow & { readonly candidate_key: string }>;

export function verifyLexicalIntervalProducerReplay(
  capture: Readonly<KeywordLexicalMergeCapture>,
  receipt: Readonly<LexicalBoundProducerReceipt>
): void {
  verifyLanes(capture, receipt);
  const candidates = verifyCandidateClosure(capture, receipt);
  const byKey = new Map(candidates.map((candidate) => [
    candidate.candidate_key, verifyCandidate(candidate, receipt.lanes)
  ]));
  const winners = winnersInProducerEncounterOrder(receipt.lanes, byKey);
  verifyPostMerge(receipt, winners);
}

function winnersInProducerEncounterOrder(
  lanes: readonly Readonly<LexicalBoundLaneCapture>[],
  winners: ReadonlyMap<string, Winner>
): readonly Winner[] {
  const ordered = new Map<string, Winner>();
  for (const lane of lanes) {
    for (const row of lane.rows) ordered.set(row.candidate_key, winners.get(row.candidate_key)!);
  }
  return [...ordered.values()];
}

function verifyLanes(
  capture: Readonly<KeywordLexicalMergeCapture>,
  receipt: Readonly<LexicalBoundProducerReceipt>
): void {
  if (!canonicalLaneOrder(capture.lanes)) {
    throw new TypeError("lexical interval source lane set is invalid");
  }
  if (!canonicalLaneOrder(receipt.lanes)) {
    throw new TypeError("lexical interval producer lane set is invalid");
  }
  capture.lanes.forEach((lane, index) => {
    const producer = receipt.lanes[index]!;
    verifyCaptureLane(lane, capture.merge_limit);
    if (producer.raw_key_kind !== lane.raw_key_kind || producer.list_n !== lane.list_n ||
        producer.status !== lane.status || producer.requested_limit !== capture.merge_limit ||
        producer.source_priority !== LANE_PRIORITY[lane.lane_id]) {
      throw new TypeError("lexical interval producer lane projection is invalid");
    }
    verifyLaneRows(producer);
  });
}

function verifyCaptureLane(
  lane: KeywordLexicalMergeCapture["lanes"][number],
  mergeLimit: number
): void {
  const expectedKind = lane.lane_id === "exact"
    ? "matched_token_count" : "bm25_raw_rank";
  if (lane.raw_key_kind !== expectedKind || !Number.isSafeInteger(lane.list_n) ||
      lane.list_n < 0 || lane.list_n > mergeLimit ||
      (lane.status === "empty") !== (lane.list_n === 0) ||
      (lane.status === "truncated" && lane.list_n !== mergeLimit)) {
    throw new TypeError("lexical interval source lane is invalid");
  }
}

function canonicalLaneOrder(
  lanes: readonly Readonly<{ readonly lane_id: KeywordLexicalMergeCapture["lanes"][number]["lane_id"] }>[]
): boolean {
  return lanes.length === LANE_ORDER.length &&
    lanes.every((lane, index) => lane.lane_id === LANE_ORDER[index]);
}

function verifyLaneRows(lane: Readonly<LexicalBoundLaneCapture>): void {
  if (lane.rows.length !== lane.list_n) {
    throw new TypeError("lexical interval producer lane rows are invalid");
  }
  if (new Set(lane.rows.map((row) => row.candidate_key)).size !== lane.rows.length) {
    throw new TypeError("lexical interval producer lane has duplicate candidate rows");
  }
  const expected = groupedOrdinalScores(lane.rows.map((row) => row.raw_group_key));
  lane.rows.forEach((row, index) => {
    if (row.lane_index !== index || row.grouped_ordinal !== expected[index]) {
      throw new TypeError("lexical interval producer lane row order is invalid");
    }
    if (index > 0 && !rawKeysMonotone(
      lane.raw_key_kind, lane.rows[index - 1]!.raw_group_key, row.raw_group_key
    )) throw new TypeError("lexical interval producer raw rank order is invalid");
  });
}

function groupedOrdinalScores(rawKeys: readonly number[]): readonly number[] {
  const scores = new Array<number>(rawKeys.length);
  let start = 0;
  while (start < rawKeys.length) {
    let end = start + 1;
    while (end < rawKeys.length && rawKeys[end] === rawKeys[start]) end += 1;
    let total = 0;
    for (let index = start; index < end; index += 1) {
      total += (rawKeys.length - index) / rawKeys.length;
    }
    const score = total / (end - start);
    for (let index = start; index < end; index += 1) scores[index] = score;
    start = end;
  }
  return scores;
}

function rawKeysMonotone(kind: string, previous: number, next: number): boolean {
  return kind === "matched_token_count" ? next <= previous : next >= previous;
}

function verifyCandidateClosure(
  capture: Readonly<KeywordLexicalMergeCapture>,
  receipt: Readonly<LexicalBoundProducerReceipt>
): readonly Readonly<LexicalBoundCandidateProvenance>[] {
  const rowKeys = new Set(receipt.lanes.flatMap((lane) =>
    lane.rows.map((row) => row.candidate_key)
  ));
  if (receipt.candidates.length !== rowKeys.size ||
      capture.candidates.length !== receipt.candidates.length) {
    throw new TypeError("lexical interval producer candidate closure is invalid");
  }
  receipt.candidates.forEach((candidate, index) => {
    const slim = capture.candidates[index];
    if (candidate.candidate_key.trim().length === 0 ||
        !rowKeys.has(candidate.candidate_key) || slim?.candidate_key !== candidate.candidate_key ||
        (index > 0 && compareCodeUnits(
          receipt.candidates[index - 1]!.candidate_key, candidate.candidate_key
        ) >= 0) || !sameProjection(slim, candidate)) {
      throw new TypeError("lexical interval producer candidate order is invalid");
    }
  });
  return receipt.candidates;
}

function sameProjection(
  slim: KeywordLexicalMergeCapture["candidates"][number] | undefined,
  full: Readonly<LexicalBoundCandidateProvenance>
): boolean {
  return slim !== undefined && slim.admitted === full.admitted &&
    slim.chosen_lane_id === full.chosen_lane_id &&
    slim.chosen_normalized_rank === full.chosen_normalized_rank;
}

function verifyCandidate(
  candidate: Readonly<LexicalBoundCandidateProvenance>,
  lanes: readonly Readonly<LexicalBoundLaneCapture>[]
): Winner {
  const observed = lanes.flatMap((lane) => lane.rows
    .filter((row) => row.candidate_key === candidate.candidate_key)
    .map((row) => Object.freeze({ lane, row })));
  const expectedHits = observed.map(({ lane, row }) => Object.freeze({
    lane_id: lane.lane_id, raw_group_key: row.raw_group_key,
    grouped_ordinal: row.grouped_ordinal, lane_index: row.lane_index
  }));
  if (expectedHits.length !== candidate.lane_hits.length || expectedHits.some((hit, index) =>
    hitKey(hit) !== hitKey(candidate.lane_hits[index]!))) {
    throw new TypeError("lexical interval producer candidate lane hits are invalid");
  }
  const winner = observed.reduce<ObservedRow | undefined>(selectWinner, undefined);
  if (winner === undefined || candidate.chosen_lane_id !== winner.lane.lane_id ||
      candidate.chosen_normalized_rank !== winner.row.grouped_ordinal) {
    throw new TypeError("lexical interval producer candidate winner is invalid");
  }
  const discarded = expectedHits.map((hit) => hit.lane_id)
    .filter((laneId) => laneId !== winner.lane.lane_id);
  if (discarded.length !== candidate.discarded_lane_ids.length || discarded.some(
    (laneId, index) => candidate.discarded_lane_ids[index] !== laneId
  )) throw new TypeError("lexical interval producer discarded lanes are invalid");
  return Object.freeze({ candidate_key: candidate.candidate_key, ...winner });
}

function selectWinner(current: ObservedRow | undefined, next: ObservedRow): ObservedRow {
  if (current === undefined || next.row.grouped_ordinal > current.row.grouped_ordinal ||
      (next.row.grouped_ordinal === current.row.grouped_ordinal &&
        next.lane.source_priority < current.lane.source_priority)) return next;
  return current;
}

function verifyPostMerge(
  receipt: Readonly<LexicalBoundProducerReceipt>, winners: readonly Winner[]
): void {
  const expected = [...winners].sort(compareWinners).slice(0, receipt.merge_limit);
  if (receipt.post_merge.length !== expected.length) {
    throw new TypeError("lexical interval producer post-merge set is invalid");
  }
  expected.forEach((winner, index) => {
    const row = receipt.post_merge[index];
    const candidate = receipt.candidates.find((item) => item.candidate_key === winner.candidate_key);
    if (row?.candidate_key !== winner.candidate_key ||
        row.normalized_rank !== winner.row.grouped_ordinal ||
        candidate?.admitted !== true || candidate.post_merge_index !== index) {
      throw new TypeError("lexical interval producer post-merge order is invalid");
    }
    verifyOptionalPostMergeRanks(row, winner.candidate_key, receipt.lanes);
  });
  const admitted = new Set(expected.map((winner) => winner.candidate_key));
  if (receipt.candidates.some((candidate) =>
    candidate.admitted !== admitted.has(candidate.candidate_key) ||
    (!candidate.admitted && candidate.post_merge_index !== null))) {
    throw new TypeError("lexical interval producer candidate admission is invalid");
  }
}

function verifyOptionalPostMergeRanks(
  row: LexicalBoundProducerReceipt["post_merge"][number] | undefined,
  candidateKey: string,
  lanes: readonly Readonly<LexicalBoundLaneCapture>[]
): void {
  const trigram = maxLaneRank(lanes, candidateKey, ["trigram"]);
  const objectKey = maxLaneRank(
    lanes, candidateKey, ["object_key_porter", "object_key_trigram"]
  );
  if (row === undefined || !sameOptionalRank(row, "trigram_rank", trigram) ||
      !sameOptionalRank(row, "object_key_rank", objectKey)) {
    throw new TypeError("lexical interval producer post-merge optional ranks are invalid");
  }
}

function maxLaneRank(
  lanes: readonly Readonly<LexicalBoundLaneCapture>[],
  candidateKey: string,
  laneIds: readonly LexicalBoundLaneCapture["lane_id"][]
): number | undefined {
  const ranks = lanes.filter((lane) => laneIds.includes(lane.lane_id))
    .flatMap((lane) => lane.rows.filter((row) => row.candidate_key === candidateKey)
      .map((row) => row.grouped_ordinal));
  return ranks.length === 0 ? undefined : Math.max(...ranks);
}

function sameOptionalRank(
  row: LexicalBoundProducerReceipt["post_merge"][number],
  key: "trigram_rank" | "object_key_rank",
  expected: number | undefined
): boolean {
  return Object.prototype.hasOwnProperty.call(row, key) === (expected !== undefined) &&
    row[key] === expected;
}

function compareWinners(left: Winner, right: Winner): number {
  return right.row.grouped_ordinal - left.row.grouped_ordinal ||
    left.lane.source_priority - right.lane.source_priority ||
    left.row.lane_index - right.row.lane_index ||
    left.candidate_key.localeCompare(right.candidate_key);
}

function hitKey(hit: Readonly<LexicalBoundLaneHit>): string {
  return JSON.stringify([hit.lane_id, hit.raw_group_key, hit.grouped_ordinal, hit.lane_index]);
}
