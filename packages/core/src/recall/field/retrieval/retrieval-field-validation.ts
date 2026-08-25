import {
  EvidenceSearchProjectionKindSchema,
  isCanonicalFtsLaneIds,
  type FtsLaneId
} from "@do-soul/alaya-protocol";

import { stableStringify } from "../../../shared/stable-stringify.js";
import type {
  KeywordLexicalLaneId,
  KeywordLexicalMergeCapture,
  KeywordSearchFieldRefinementLevel,
  KeywordSearchFieldResult,
  KeywordSearchLaneObservation,
  KeywordSearchLaneReceipt,
  KeywordSearchResult
} from "../../runtime/recall-service-types.js";

export function freezeFieldResult(
  value: unknown,
  maxMatches: number
): Readonly<KeywordSearchFieldResult> {
  const base = freezeFieldView(value, maxMatches);
  const rawLevels = isRecord(value) ? value.refinement_levels : undefined;
  if (rawLevels === undefined) return base;
  if (!Array.isArray(rawLevels) || !isDenseArray(rawLevels)) {
    throw new TypeError("keyword field refinement levels must be a dense array");
  }
  const levels: Readonly<KeywordSearchFieldRefinementLevel>[] = [];
  let previous = Object.freeze({ requested_depth: maxMatches, ...base });
  for (const rawLevel of rawLevels) {
    const level = freezeRefinementLevel(rawLevel);
    assertFieldRefinement(previous, level);
    levels.push(level);
    previous = level;
  }
  return Object.freeze({
    ...base,
    refinement_levels: Object.freeze(levels)
  });
}

function freezeRefinementLevel(value: unknown): Readonly<KeywordSearchFieldRefinementLevel> {
  if (!isRecord(value) || !Number.isSafeInteger(value.requested_depth) ||
      Number(value.requested_depth) <= 0) {
    throw new TypeError("keyword field refinement depth is invalid");
  }
  const requestedDepth = Number(value.requested_depth);
  return Object.freeze({
    requested_depth: requestedDepth,
    ...freezeFieldView(value, requestedDepth)
  });
}

function freezeFieldView(
  value: unknown,
  maxMatches: number
): Readonly<Pick<KeywordSearchFieldResult, "matches" | "lanes" | "lexical_raw_rank">> {
  if (!isRecord(value) || !Array.isArray(value.matches) || !Array.isArray(value.lanes)) {
    throw new TypeError("keyword field result shape is invalid");
  }
  if (!isDenseArray(value.matches) || !isDenseArray(value.lanes)) {
    throw new TypeError("keyword field result arrays must be dense");
  }
  if (value.matches.length > maxMatches) throw new FieldResultLimitError();
  const matches = Object.freeze(value.matches.map(freezeSearchResult));
  const lanes = Object.freeze(value.lanes.map(freezeLaneReceipt));
  assertFieldLanes(lanes, maxMatches);
  const lexicalRawRank = freezeLexicalMergeCapture(value.lexical_raw_rank);
  return Object.freeze({
    matches,
    lanes,
    ...(lexicalRawRank === undefined ? {} : { lexical_raw_rank: lexicalRawRank })
  });
}

function assertFieldRefinement(
  previous: Readonly<KeywordSearchFieldRefinementLevel>,
  next: Readonly<KeywordSearchFieldRefinementLevel>
): void {
  if (next.requested_depth <= previous.requested_depth) {
    throw new Error("keyword field refinement depths must increase");
  }
  assertMatchPrefix(previous.matches, next.matches);
  previous.lanes.forEach((lane, index) =>
    assertLaneRefinement(lane, next.lanes[index]!)
  );
}

function assertMatchPrefix(
  previous: readonly Readonly<KeywordSearchResult>[],
  next: readonly Readonly<KeywordSearchResult>[]
): void {
  const prefix = next.slice(0, previous.length).map(searchIdentity);
  if (stableStringify(prefix) !== stableStringify(previous.map(searchIdentity))) {
    throw new Error("keyword field refinement must preserve the match identity prefix");
  }
}

function assertLaneRefinement(
  previous: Readonly<KeywordSearchLaneReceipt>,
  next: Readonly<KeywordSearchLaneReceipt>
): void {
  if (previous.lane !== next.lane) {
    throw new Error("keyword field refinement lane order changed");
  }
  if (previous.status !== "truncated") {
    if (stableStringify(previous) !== stableStringify(next)) {
      throw new Error("closed keyword field lane cannot change within one observation");
    }
    return;
  }
  if ((next.status !== "truncated" && next.status !== "complete") ||
      next.depth < previous.depth ||
      (next.unseen_upper_bound !== null && previous.unseen_upper_bound !== null &&
        next.unseen_upper_bound > previous.unseen_upper_bound)) {
    throw new Error("keyword field refinement widened status, depth, or unseen bound");
  }
  const prefix = next.observations.slice(0, previous.observations.length)
    .map(observationIdentity);
  if (stableStringify(prefix) !==
      stableStringify(previous.observations.map(observationIdentity))) {
    throw new Error("keyword field refinement must preserve the lane identity/source prefix");
  }
}

function searchIdentity(value: Readonly<KeywordSearchResult>): unknown {
  return {
    object_id: value.object_id,
    matched_projection: value.matched_projection ?? null
  };
}

function observationIdentity(value: Readonly<KeywordSearchLaneObservation>): unknown {
  return {
    object_id: value.object_id,
    matched_projection: value.matched_projection ?? null,
    source_id: value.source_id ?? null,
    rank: value.rank
  };
}

function freezeSearchResult(value: unknown): Readonly<KeywordSearchResult> {
  if (!isRecord(value) || !isSearchResult(value)) {
    throw new TypeError("keyword field match shape is invalid");
  }
  return Object.freeze({
    ...value,
    ...(value.matched_fts_lanes === undefined
      ? {}
      : { matched_fts_lanes: Object.freeze([...value.matched_fts_lanes]) }),
    ...(value.matched_projection === undefined
      ? {}
      : { matched_projection: Object.freeze({ ...value.matched_projection }) })
  });
}

function freezeLaneReceipt(value: unknown): Readonly<KeywordSearchLaneReceipt> {
  if (!isRecord(value) || !isLaneReceipt(value)) {
    throw new TypeError("keyword field lane receipt shape is invalid");
  }
  return Object.freeze({
    ...value,
    observations: Object.freeze(value.observations.map((observation) => Object.freeze({
      ...freezeSearchResult(observation),
      rank: observation.rank,
      ...(observation.source_id === undefined ? {} : { source_id: observation.source_id })
    })))
  });
}

function isSearchResult(value: Record<string, unknown>): value is
  Record<string, unknown> & KeywordSearchResult {
  return typeof value.object_id === "string" && value.object_id.trim().length > 0 &&
    unitInterval(value.normalized_rank) &&
    (value.trigram_rank === undefined || unitInterval(value.trigram_rank)) &&
    (value.object_key_rank === undefined || unitInterval(value.object_key_rank)) &&
    (value.matched_fts_lanes === undefined || isCanonicalFtsLaneIds(value.matched_fts_lanes)) &&
    isProjectionIdentity(value.matched_projection);
}

function isProjectionIdentity(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return Number.isInteger(value.projection_id) && Number(value.projection_id) > 0 &&
    EvidenceSearchProjectionKindSchema.safeParse(value.projection_kind).success;
}

function isLaneReceipt(value: Record<string, unknown>): value is
  Record<string, unknown> & KeywordSearchLaneReceipt {
  return isFtsLaneId(value.lane) && isLaneStatus(value.status) &&
    Number.isInteger(value.depth) && Number(value.depth) >= 0 &&
    Array.isArray(value.observations) && isDenseArray(value.observations) &&
    (value.unseen_upper_bound === null || unitInterval(value.unseen_upper_bound)) &&
    (value.status === "complete" || value.unseen_upper_bound !== 0);
}

function assertFieldLanes(
  lanes: readonly Readonly<KeywordSearchLaneReceipt>[],
  maxMatches: number
): void {
  const identities = new Set<FtsLaneId>();
  for (const lane of lanes) {
    if (identities.has(lane.lane)) throw new Error("keyword field lanes must be unique");
    identities.add(lane.lane);
    if (lane.depth !== lane.observations.length || lane.depth > maxMatches) {
      throw new FieldResultLimitError();
    }
    lane.observations.forEach((observation, index) => {
      if (observation.rank !== index + 1 ||
          (observation.source_id !== undefined && observation.source_id.trim().length === 0)) {
        throw new Error("keyword field observation score or rank is invalid");
      }
    });
  }
  if (identities.size !== 3) throw new Error("keyword field must report every FTS lane");
}

function freezeLexicalMergeCapture(value: unknown): Readonly<KeywordLexicalMergeCapture> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value.query_run_id !== "string" ||
      !Number.isInteger(value.merge_limit) || !Array.isArray(value.lanes) ||
      !Array.isArray(value.candidates)) {
    throw new TypeError("keyword lexical merge capture is invalid");
  }
  return Object.freeze({
    query_run_id: value.query_run_id,
    merge_limit: Number(value.merge_limit),
    lanes: Object.freeze(value.lanes.map(freezeLexicalCaptureLane)),
    candidates: Object.freeze(value.candidates.map(freezeLexicalCaptureCandidate))
  });
}

function freezeLexicalCaptureLane(value: unknown): KeywordLexicalMergeCapture["lanes"][number] {
  if (!isRecord(value) || !isLexicalLaneId(value.lane_id) ||
      (value.raw_key_kind !== "matched_token_count" && value.raw_key_kind !== "bm25_raw_rank") ||
      !Number.isInteger(value.list_n) ||
      (value.status !== "empty" && value.status !== "complete" && value.status !== "truncated")) {
    throw new TypeError("keyword lexical merge lane is invalid");
  }
  return Object.freeze({
    lane_id: value.lane_id,
    raw_key_kind: value.raw_key_kind,
    list_n: Number(value.list_n),
    status: value.status
  });
}

function freezeLexicalCaptureCandidate(
  value: unknown
): KeywordLexicalMergeCapture["candidates"][number] {
  if (!isRecord(value) || typeof value.candidate_key !== "string" ||
      (value.chosen_lane_id !== null && !isLexicalLaneId(value.chosen_lane_id)) ||
      (value.chosen_normalized_rank !== null && !unitInterval(value.chosen_normalized_rank)) ||
      typeof value.admitted !== "boolean") {
    throw new TypeError("keyword lexical merge candidate is invalid");
  }
  return Object.freeze({
    candidate_key: value.candidate_key,
    chosen_lane_id: value.chosen_lane_id,
    chosen_normalized_rank: value.chosen_normalized_rank,
    admitted: value.admitted
  });
}

function isLexicalLaneId(value: unknown): value is KeywordLexicalLaneId {
  return value === "exact" || value === "porter" || value === "trigram" ||
    value === "object_key_porter" || value === "object_key_trigram";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDenseArray(value: readonly unknown[]): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) return false;
  }
  return true;
}

function unitInterval(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isFtsLaneId(value: unknown): value is FtsLaneId {
  return value === "exact" || value === "porter" || value === "trigram";
}

function isLaneStatus(value: unknown): boolean {
  return value === "complete" || value === "truncated" ||
    value === "unavailable" || value === "ineligible";
}

export class FieldResultLimitError extends Error {}
