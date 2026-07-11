import type { MemoryEntry, PathAnchorRef } from "@do-soul/alaya-protocol";

import { deriveQuerySoughtFacets } from "../query/query-facet-router.js";
import type { RecallQueryProbes } from "../query/recall-query-probes.js";
import { parseQueryTimeWindow } from "../scoring/temporal-fusion-scoring.js";
import {
  createSelectedSliceKeyV1,
  intersectSelectedSliceKeysV1,
  type SelectedSliceKeyInputV1,
  type SelectedSliceKeyMatchV1,
  type SelectedSliceKeyV1
} from "./slice-key-contract.js";

const DAY_MS = 86_400_000;
const SHORT_TIME_WINDOW_DAYS = 31;
export const SLICE_TIME_BUCKET_LIMIT_V1 = 120;
const QUERY_SOURCE_VERSION = "query-probes-v1";
const STRONG_SLICE_DIMENSIONS = new Set(["time", "space", "entity"]);

interface QuerySliceKeyDerivationInputV1 {
  readonly workspaceId: string;
  readonly queryProbes: Readonly<RecallQueryProbes>;
  readonly asOfMs: number;
  readonly nowIso?: string;
}

interface MemorySliceKeyDerivationInputV1 {
  readonly workspaceId: string;
  readonly entry: Readonly<MemoryEntry>;
  readonly asOfMs: number;
}

interface PathAnchorSliceKeyDerivationInputV1 {
  readonly workspaceId: string;
  readonly pathId: string;
  readonly side: "source" | "target";
  readonly anchor: Readonly<PathAnchorRef>;
  readonly sourceVersion: string;
  readonly asOfMs: number;
}

export type SliceCompatibilityReasonV1 =
  | "no_query_key"
  | "missing_source_key"
  | "missing_target_key"
  | "missing_source_and_target_key"
  | "no_slice_match"
  | "slice_match";

export interface SliceCompatibilityV1 {
  readonly decision: "pass_through" | "compatible" | "rejected";
  readonly reason: SliceCompatibilityReasonV1;
  readonly matches: readonly Readonly<SelectedSliceKeyMatchV1>[];
}

export interface SliceCompatibilityInputV1 {
  readonly queryKeys: readonly SelectedSliceKeyV1[];
  readonly sourceKeys: readonly SelectedSliceKeyV1[];
  readonly targetKeys: readonly SelectedSliceKeyV1[];
}

export function selectSliceCompatibilityV1(
  input: SliceCompatibilityInputV1
): Readonly<SliceCompatibilityV1> {
  const queryKeys = freshKeys(input.queryKeys);
  if (queryKeys.length === 0) {
    return compatibility("pass_through", "no_query_key", []);
  }
  const strongQueryKeys = queryKeys.filter((key) =>
    STRONG_SLICE_DIMENSIONS.has(key.dimension)
  );
  const routedQueryKeys = strongQueryKeys.length > 0
    ? strongQueryKeys
    : queryKeys.filter((key) => key.dimension === "semantic");
  if (routedQueryKeys.length === 0) {
    return compatibility("pass_through", "no_query_key", []);
  }
  const evaluations = routedDimensions(routedQueryKeys).map((dimension) =>
    evaluateRoutedDimension(
      routedQueryKeys.filter((key) => key.dimension === dimension),
      freshKeys(input.sourceKeys),
      freshKeys(input.targetKeys)
    )
  );
  if (evaluations.some((evaluation) => evaluation.state === "disjoint")) {
    return compatibility("rejected", "no_slice_match", []);
  }
  const unavailable = evaluations.filter((evaluation) => evaluation.state === "unavailable");
  if (unavailable.length > 0) {
    return compatibility("pass_through", missingProjectionReason(unavailable), []);
  }
  return compatibility(
    "compatible",
    "slice_match",
    evaluations.flatMap((evaluation) => evaluation.matches)
  );
}

interface RoutedDimensionEvaluation {
  readonly state: "matched" | "disjoint" | "unavailable";
  readonly missingSource: boolean;
  readonly missingTarget: boolean;
  readonly matches: readonly Readonly<SelectedSliceKeyMatchV1>[];
}

function evaluateRoutedDimension(
  queryKeys: readonly SelectedSliceKeyV1[],
  sourceKeys: readonly SelectedSliceKeyV1[],
  targetKeys: readonly SelectedSliceKeyV1[]
): Readonly<RoutedDimensionEvaluation> {
  const sourceComparable = comparableEndpointKeys(queryKeys, sourceKeys);
  const targetComparable = comparableEndpointKeys(queryKeys, targetKeys);
  if (sourceComparable.length === 0 || targetComparable.length === 0) {
    return Object.freeze({
      state: "unavailable",
      missingSource: sourceComparable.length === 0,
      missingTarget: targetComparable.length === 0,
      matches: Object.freeze([])
    });
  }
  const matches = intersectSelectedSliceKeysV1(queryKeys, sourceComparable, targetComparable);
  return Object.freeze({
    state: matches.length === 0 ? "disjoint" : "matched",
    missingSource: false,
    missingTarget: false,
    matches
  });
}

function comparableEndpointKeys(
  queryKeys: readonly SelectedSliceKeyV1[],
  endpointKeys: readonly SelectedSliceKeyV1[]
): readonly SelectedSliceKeyV1[] {
  const workspaces = new Set(queryKeys.map((key) => key.workspace_id));
  const dimension = queryKeys[0]?.dimension;
  return endpointKeys.filter((key) =>
    key.dimension === dimension && workspaces.has(key.workspace_id)
  );
}

function routedDimensions(keys: readonly SelectedSliceKeyV1[]): readonly string[] {
  return [...new Set(keys.map((key) => key.dimension))].sort();
}

function missingProjectionReason(
  evaluations: readonly Readonly<RoutedDimensionEvaluation>[]
): SliceCompatibilityReasonV1 {
  const missingSource = evaluations.some((evaluation) => evaluation.missingSource);
  const missingTarget = evaluations.some((evaluation) => evaluation.missingTarget);
  if (missingSource && missingTarget) return "missing_source_and_target_key";
  return missingSource ? "missing_source_key" : "missing_target_key";
}

export function deriveQuerySliceKeysV1(
  input: QuerySliceKeyDerivationInputV1
): readonly SelectedSliceKeyV1[] {
  const inputs = [
    ...deriveQuerySemanticInputs(input),
    ...deriveQueryTimeInputs(input)
  ];
  return createKeys(inputs);
}

export function deriveMemorySliceKeysV1(
  input: MemorySliceKeyDerivationInputV1
): readonly SelectedSliceKeyV1[] {
  if (input.workspaceId !== input.entry.workspace_id) {
    return Object.freeze([]);
  }
  const inputs = [
    ...deriveMemoryFacetInputs(input),
    ...deriveMemoryEntityInputs(input),
    ...deriveMemoryTimeInputs(input)
  ];
  return createKeys(inputs);
}

export function derivePathAnchorSliceKeysV1(
  input: PathAnchorSliceKeyDerivationInputV1
): readonly SelectedSliceKeyV1[] {
  const sourceRef = `path:${input.pathId}:${input.side}`;
  if (input.anchor.kind === "object") {
    return Object.freeze([]);
  }
  if (input.anchor.kind === "object_facet") {
    return createKeys([sliceInput(input, "semantic", input.anchor.facet_key, {
      kind: "path_facet",
      source_ref: sourceRef
    })]);
  }
  if (input.anchor.kind === "time_concern") {
    return createKeys([sliceInput(input, "time", `concern:${input.anchor.window_digest}`, {
      kind: "time_concern",
      source_ref: sourceRef
    })]);
  }
  return Object.freeze([]);
}

function deriveQuerySemanticInputs(
  input: QuerySliceKeyDerivationInputV1
): readonly SelectedSliceKeyInputV1[] {
  return deriveQuerySoughtFacets(input.queryProbes).map((facet) =>
    sliceInput(input, "semantic", facet, {
      kind: "query_probe",
      source_ref: `query:facet:${facet}`
    })
  );
}

function deriveQueryTimeInputs(
  input: QuerySliceKeyDerivationInputV1
): readonly SelectedSliceKeyInputV1[] {
  if (hasInvalidAbsoluteDate(input.queryProbes.date_terms)) {
    return [];
  }
  const window = parseQueryTimeWindow(input.queryProbes, input.nowIso);
  const buckets = window === null ? [] : timeBucketValues(window.startMs, window.endMs);
  return buckets.map((bucket) => sliceInput(input, "time", bucket, {
    kind: "query_probe",
    source_ref: "query:event-time-window"
  }));
}

function deriveMemoryFacetInputs(
  input: MemorySliceKeyDerivationInputV1
): readonly SelectedSliceKeyInputV1[] {
  return (input.entry.facet_tags ?? []).flatMap((tag) => {
    const facet = tag.facet.trim();
    const semantic = memoryInput(input, "semantic", facet, "facet_tag", `facet:${facet}`);
    const place = tag.value?.trim() ?? "";
    if (facet.toLowerCase() !== "location_place" || place.length === 0) {
      return [semantic];
    }
    return [
      semantic,
      memoryInput(input, "space", place, "location_facet", `facet:${facet}:value:${place}`)
    ];
  });
}

function deriveMemoryEntityInputs(
  input: MemorySliceKeyDerivationInputV1
): readonly SelectedSliceKeyInputV1[] {
  return (input.entry.canonical_entities ?? []).map((entity) =>
    memoryInput(input, "entity", entity, "canonical_entity", `entity:${entity}`)
  );
}

function deriveMemoryTimeInputs(
  input: MemorySliceKeyDerivationInputV1
): readonly SelectedSliceKeyInputV1[] {
  const interval = parseEventInterval(input.entry.event_time_start, input.entry.event_time_end);
  const buckets = interval === null ? [] : timeBucketValues(interval.startMs, interval.endMs);
  return buckets.map((bucket) =>
    memoryInput(input, "time", bucket, "event_time", "event-time")
  );
}

function memoryInput(
  input: MemorySliceKeyDerivationInputV1,
  dimension: string,
  value: string,
  kind: SelectedSliceKeyInputV1["provenance"]["kind"],
  sourceSuffix: string
): SelectedSliceKeyInputV1 {
  return sliceInput(input, dimension, value, {
    kind,
    source_ref: `memory:${input.entry.object_id}:${sourceSuffix}`
  });
}

function sliceInput(
  input: {
    readonly workspaceId: string;
    readonly asOfMs: number;
    readonly sourceVersion?: string;
    readonly entry?: Readonly<MemoryEntry>;
  },
  dimension: string,
  value: string,
  provenance: SelectedSliceKeyInputV1["provenance"]
): SelectedSliceKeyInputV1 {
  return {
    workspace_id: input.workspaceId,
    dimension,
    value,
    provenance,
    source_version: sourceVersion(input),
    freshness: { state: "fresh", as_of_ms: input.asOfMs }
  };
}

function sourceVersion(input: { readonly sourceVersion?: string; readonly entry?: MemoryEntry }): string {
  if (input.sourceVersion !== undefined) {
    return input.sourceVersion;
  }
  if (input.entry !== undefined) {
    return `projection:${input.entry.projection_schema_version ?? "legacy"}:${input.entry.updated_at}`;
  }
  return QUERY_SOURCE_VERSION;
}

function createKeys(inputs: readonly SelectedSliceKeyInputV1[]): readonly SelectedSliceKeyV1[] {
  const byId = new Map<string, SelectedSliceKeyV1>();
  for (const input of inputs) {
    try {
      const key = createSelectedSliceKeyV1(input);
      byId.set(key.key_id, key);
    } catch {
      // invariant: invalid projections contribute no key and never widen compatibility.
    }
  }
  return Object.freeze([...byId.values()].sort((left, right) =>
    left.key_id < right.key_id ? -1 : left.key_id > right.key_id ? 1 : 0
  ));
}

function parseEventInterval(
  start: string | null | undefined,
  end: string | null | undefined
): Readonly<{ readonly startMs: number; readonly endMs: number }> | null {
  if (start === null || start === undefined) {
    return null;
  }
  const startMs = Date.parse(start);
  const endMs = end === null || end === undefined ? startMs : Date.parse(end);
  return validInterval(startMs, endMs) ? Object.freeze({ startMs, endMs }) : null;
}

function validInterval(startMs: number, endMs: number): boolean {
  return Number.isSafeInteger(startMs) && Number.isSafeInteger(endMs) && startMs <= endMs;
}

function timeBucketValues(startMs: number, endMs: number): readonly string[] {
  if (!validInterval(startMs, endMs)) {
    return [];
  }
  const monthBuckets = collectMonthBuckets(startMs, endMs);
  if (monthBuckets === null) {
    return [];
  }
  if (endMs - startMs >= SHORT_TIME_WINDOW_DAYS * DAY_MS) {
    return monthBuckets;
  }
  const dayBuckets = collectDayBuckets(startMs, endMs);
  const buckets = [...dayBuckets, ...monthBuckets];
  return buckets.length <= SLICE_TIME_BUCKET_LIMIT_V1 ? buckets : [];
}

function collectDayBuckets(startMs: number, endMs: number): readonly string[] {
  const buckets: string[] = [];
  let cursor = utcDayStart(startMs);
  while (cursor <= endMs && buckets.length <= SHORT_TIME_WINDOW_DAYS) {
    buckets.push(`day:${new Date(cursor).toISOString().slice(0, 10)}`);
    cursor += DAY_MS;
  }
  return buckets;
}

function collectMonthBuckets(startMs: number, endMs: number): readonly string[] | null {
  const buckets: string[] = [];
  let cursor = utcMonthStart(startMs);
  while (cursor <= endMs) {
    if (buckets.length >= SLICE_TIME_BUCKET_LIMIT_V1) {
      return null;
    }
    buckets.push(`month:${new Date(cursor).toISOString().slice(0, 7)}`);
    const date = new Date(cursor);
    cursor = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  }
  return buckets;
}

function utcDayStart(value: number): number {
  const date = new Date(value);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function utcMonthStart(value: number): number {
  const date = new Date(value);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

function hasInvalidAbsoluteDate(terms: readonly string[]): boolean {
  return terms.some((term) => {
    const isoDay = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(term);
    if (isoDay !== null) {
      return !isCalendarDate(Number(isoDay[1]), Number(isoDay[2]), Number(isoDay[3]));
    }
    const isoMonth = /^(\d{4})-(\d{2})$/u.exec(term);
    if (isoMonth !== null) {
      return !isCalendarMonth(Number(isoMonth[1]), Number(isoMonth[2]));
    }
    const cjkDay = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/u.exec(term);
    if (cjkDay !== null) {
      return !isCalendarDate(Number(cjkDay[1]), Number(cjkDay[2]), Number(cjkDay[3]));
    }
    const cjkMonth = /^(\d{4})年(\d{1,2})月$/u.exec(term);
    return cjkMonth !== null &&
      !isCalendarMonth(Number(cjkMonth[1]), Number(cjkMonth[2]));
  });
}

function isCalendarMonth(year: number, month: number): boolean {
  return Number.isSafeInteger(year) && year >= 100 && month >= 1 && month <= 12;
}

function isCalendarDate(year: number, month: number, day: number): boolean {
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day;
}

function freshKeys(keys: readonly SelectedSliceKeyV1[]): readonly SelectedSliceKeyV1[] {
  return keys.filter((key) => key.freshness.state === "fresh");
}

function compatibility(
  decision: SliceCompatibilityV1["decision"],
  reason: SliceCompatibilityReasonV1,
  matches: readonly Readonly<SelectedSliceKeyMatchV1>[]
): Readonly<SliceCompatibilityV1> {
  return Object.freeze({ decision, reason, matches: Object.freeze([...matches]) });
}
