import { type MemoryEntry } from "@do-soul/alaya-protocol";
import {
  parseAbsoluteTemporalWindow,
  parseRelativeTemporalTerm,
  resolveRelativeTemporalWindow
} from "./temporal-window.js";
import { clamp01 } from "../runtime/recall-service-helpers.js";
import type { RecallQueryProbes } from "../query/recall-query-probes.js";
import { classifyRecallIntent, hasTemporalQuerySignal } from "../query/recall-query-plan.js";
import type { RecallFusionStream } from "../runtime/recall-service-types.js";
import { recallProjectionScoringEnabled } from "../../config/recall-env-access.js";

export function resolveDefaultFusionWeightForIntent(
  stream: RecallFusionStream,
  baseWeight: number,
  queryProbes: Readonly<RecallQueryProbes>
): number {
  return resolveDefaultFusionWeightForIntentWithDiagnostics(stream, baseWeight, queryProbes).weight;
}

export interface FusionWeightResolutionDiagnostic {
  readonly weight: number;
  readonly baseWeight: number;
  readonly adjustment:
    | "none"
    | "subject_alignment_preference_floor"
    | "temporal_intent_floor";
}

export function resolveDefaultFusionWeightForIntentWithDiagnostics(
  stream: RecallFusionStream,
  baseWeight: number,
  queryProbes: Readonly<RecallQueryProbes>
): FusionWeightResolutionDiagnostic {
  if (!recallProjectionScoringEnabled()) {
    return { weight: baseWeight, baseWeight, adjustment: "none" };
  }
  const intent = classifyRecallIntent(queryProbes);
  if (stream === "subject_alignment" && intent === "preference") {
    const weight = Math.max(baseWeight, 2);
    return {
      weight,
      baseWeight,
      adjustment: weight === baseWeight ? "none" : "subject_alignment_preference_floor"
    };
  }
  if (stream !== "temporal_recency" || baseWeight > 0) {
    return { weight: baseWeight, baseWeight, adjustment: "none" };
  }
  const weight = hasTemporalQuerySignal(queryProbes, intent) ? 4 : baseWeight;
  return {
    weight,
    baseWeight,
    adjustment: weight === baseWeight ? "none" : "temporal_intent_floor"
  };
}

export { recallProjectionScoringEnabled } from "../../config/recall-env-access.js";

export interface QueryTimeWindow {
  readonly startMs: number;
  readonly endMs: number;
}

const QUERY_WINDOW_DECAY_DAYS = 90;

// Object-time facet: distance to the question's asked-about window, independent of distance-to-now.
// Absolute terms resolve anchor-free; relative terms resolve only when nowIso supplies the now-anchor.
export function parseQueryTimeWindow(
  queryProbes: Readonly<RecallQueryProbes>,
  nowIso?: string
): QueryTimeWindow | null {
  const offsetMinutes = nowIso === undefined ? 0 : parseFixedOffsetMinutes(nowIso) ?? 0;
  for (const term of queryProbes.date_terms) {
    const window = parseAbsoluteTemporalWindow(term, offsetMinutes);
    if (window !== null) {
      return { startMs: window.startMs, endMs: window.endMs };
    }
  }
  const anchorMs = nowIso === undefined ? null : parseOptionalTime(nowIso);
  if (anchorMs === null) {
    return null;
  }
  for (const term of queryProbes.date_terms) {
    const window = parseRelativeDateWindow(term, anchorMs, offsetMinutes);
    if (window !== null) {
      return window;
    }
  }
  return null;
}

// Relative date_terms (incl. seasons + "N units ago") resolve through the shared protocol window math.
function parseRelativeDateWindow(
  term: string,
  anchorMs: number,
  offsetMinutes: number
): QueryTimeWindow | null {
  const relativeTerm = parseRelativeTemporalTerm(term);
  if (relativeTerm === null) {
    return null;
  }
  const window = resolveRelativeTemporalWindow(relativeTerm, anchorMs, offsetMinutes);
  return { startMs: window.startMs, endMs: window.endMs };
}

export function scoreTemporalQueryWindow(
  entry: Readonly<MemoryEntry>,
  window: QueryTimeWindow,
  nowIso: string
): number {
  const eventStartMs = parseOptionalTime(entry.event_time_start);
  if (eventStartMs === null) {
    return 0;
  }
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) {
    return 0;
  }
  const { startMs, endMs: eventEndMs } = normalizeEventTimeInterval(
    eventStartMs,
    parseOptionalTime(entry.event_time_end)
  );
  if (!isWithinValidTime(entry, nowMs)) {
    return 0;
  }
  if (startMs <= window.endMs && eventEndMs >= window.startMs) {
    return 1;
  }
  const distanceMs =
    eventEndMs < window.startMs ? window.startMs - eventEndMs : startMs - window.endMs;
  const distanceDays = Math.max(0, distanceMs / 86_400_000);
  return clamp01(1 - distanceDays / QUERY_WINDOW_DECAY_DAYS);
}

export function scoreTemporalEventTime(entry: Readonly<MemoryEntry>, nowIso: string): number {
  const eventStartMs = parseOptionalTime(entry.event_time_start);
  const nowMs = Date.parse(nowIso);
  if (eventStartMs === null || !Number.isFinite(nowMs)) {
    return 0;
  }
  if (!isWithinValidTime(entry, nowMs)) {
    return 0;
  }
  const { startMs, endMs: intervalEndMs } = normalizeEventTimeInterval(
    eventStartMs,
    parseOptionalTime(entry.event_time_end)
  );
  if (nowMs >= startMs && nowMs <= intervalEndMs) {
    return 1;
  }
  const distanceMs = nowMs < startMs ? startMs - nowMs : nowMs - intervalEndMs;
  const distanceDays = Math.max(0, distanceMs / 86_400_000);
  return clamp01(1 - distanceDays / 365);
}

function isWithinValidTime(entry: Readonly<MemoryEntry>, nowMs: number): boolean {
  const validFromMs = parseOptionalTime(entry.valid_from);
  const validToMs = parseOptionalTime(entry.valid_to);
  if (validFromMs !== null && nowMs < validFromMs) {
    return false;
  }
  return validToMs === null || nowMs <= validToMs;
}

function parseOptionalTime(value: string | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseFixedOffsetMinutes(value: string): number | null {
  if (/z$/iu.test(value)) {
    return 0;
  }
  const match = /([+-])(\d{2}):(\d{2})$/u.exec(value);
  if (match === null) {
    return null;
  }
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  if (hours > 23 || minutes > 59) {
    return null;
  }
  const total = hours * 60 + minutes;
  return match[1] === "-" ? -total : total;
}

function normalizeEventTimeInterval(
  eventStartMs: number,
  eventEndMs: number | null
): Readonly<{ readonly startMs: number; readonly endMs: number }> {
  const endMs = eventEndMs ?? eventStartMs;
  if (eventStartMs <= endMs) {
    return Object.freeze({ startMs: eventStartMs, endMs });
  }
  return Object.freeze({ startMs: endMs, endMs: eventStartMs });
}
