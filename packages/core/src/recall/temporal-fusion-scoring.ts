import { type MemoryEntry } from "@do-soul/alaya-protocol";
import { parseRelativeTemporalTerm, resolveRelativeTemporalWindow } from "./temporal-window.js";
import { clamp01 } from "./recall-service-helpers.js";
import type { RecallQueryProbes } from "./recall-query-probes.js";
import { classifyRecallIntent } from "./recall-query-plan.js";
import type { RecallFusionStream } from "./recall-service-types.js";

export function resolveDefaultFusionWeightForIntent(
  stream: RecallFusionStream,
  baseWeight: number,
  queryProbes: Readonly<RecallQueryProbes>
): number {
  if (!recallProjectionScoringEnabled()) {
    return baseWeight;
  }
  const intent = classifyRecallIntent(queryProbes);
  if (stream === "subject_alignment" && intent === "preference") {
    return Math.max(baseWeight, 2);
  }
  if (stream !== "temporal_recency" || baseWeight > 0) {
    return baseWeight;
  }
  return intent === "temporal" || intent === "knowledge_update" ? 4 : baseWeight;
}

export function recallProjectionScoringEnabled(): boolean {
  return !/^(?:0|false|off|no)$/iu.test(process.env.ALAYA_RECALL_PROJECTIONS ?? "on");
}

export function temporalQueryWindowEnabled(): boolean {
  return /^(?:1|true|on|yes)$/iu.test(process.env.ALAYA_RECALL_TEMPORAL_WINDOW ?? "");
}

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
  for (const term of queryProbes.date_terms) {
    const window = parseAbsoluteDateWindow(term);
    if (window !== null) {
      return window;
    }
  }
  const anchorMs = nowIso === undefined ? null : parseOptionalTime(nowIso);
  if (anchorMs === null) {
    return null;
  }
  for (const term of queryProbes.date_terms) {
    const window = parseRelativeDateWindow(term, anchorMs);
    if (window !== null) {
      return window;
    }
  }
  return null;
}

function parseAbsoluteDateWindow(term: string): QueryTimeWindow | null {
  const isoDay = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(term);
  if (isoDay) {
    return dayWindow(Number(isoDay[1]), Number(isoDay[2]), Number(isoDay[3]));
  }
  const isoMonth = /^(\d{4})-(\d{2})$/u.exec(term);
  if (isoMonth) {
    return monthWindow(Number(isoMonth[1]), Number(isoMonth[2]));
  }
  const cjk = /^(\d{4})年(\d{1,2})月(?:(\d{1,2})日)?$/u.exec(term);
  if (cjk) {
    return cjk[3] === undefined
      ? monthWindow(Number(cjk[1]), Number(cjk[2]))
      : dayWindow(Number(cjk[1]), Number(cjk[2]), Number(cjk[3]));
  }
  return null;
}

function dayWindow(year: number, month: number, day: number): QueryTimeWindow | null {
  const startMs = Date.UTC(year, month - 1, day);
  return Number.isFinite(startMs) ? { startMs, endMs: startMs + 86_400_000 - 1 } : null;
}

function monthWindow(year: number, month: number): QueryTimeWindow | null {
  const startMs = Date.UTC(year, month - 1, 1);
  const endMs = Date.UTC(year, month, 1) - 1;
  return Number.isFinite(startMs) && Number.isFinite(endMs) ? { startMs, endMs } : null;
}

// Relative date_terms (incl. seasons + "N units ago") resolve through the shared protocol window math.
function parseRelativeDateWindow(term: string, anchorMs: number): QueryTimeWindow | null {
  const relativeTerm = parseRelativeTemporalTerm(term);
  if (relativeTerm === null) {
    return null;
  }
  const window = resolveRelativeTemporalWindow(relativeTerm, anchorMs);
  return { startMs: window.startMs, endMs: window.endMs };
}

export function scoreTemporalQueryWindow(
  entry: Readonly<MemoryEntry>,
  window: QueryTimeWindow
): number {
  const eventStartMs = parseOptionalTime(entry.event_time_start);
  if (eventStartMs === null) {
    return 0;
  }
  const eventEndMs = parseOptionalTime(entry.event_time_end) ?? eventStartMs;
  if (!isWithinValidTime(entry, eventStartMs)) {
    return 0;
  }
  if (eventStartMs <= window.endMs && eventEndMs >= window.startMs) {
    return 1;
  }
  const distanceMs =
    eventEndMs < window.startMs ? window.startMs - eventEndMs : eventStartMs - window.endMs;
  const distanceDays = Math.max(0, distanceMs / 86_400_000);
  return clamp01(1 - distanceDays / QUERY_WINDOW_DECAY_DAYS);
}

export function scoreTemporalEventTime(entry: Readonly<MemoryEntry>, nowIso: string): number {
  const eventStartMs = parseOptionalTime(entry.event_time_start);
  const eventEndMs = parseOptionalTime(entry.event_time_end);
  const nowMs = Date.parse(nowIso);
  if (eventStartMs === null || !Number.isFinite(nowMs)) {
    return 0;
  }
  if (!isWithinValidTime(entry, nowMs)) {
    return 0;
  }
  const intervalEndMs = eventEndMs ?? eventStartMs;
  if (nowMs >= eventStartMs && nowMs <= intervalEndMs) {
    return 1;
  }
  const distanceMs = nowMs < eventStartMs ? eventStartMs - nowMs : nowMs - intervalEndMs;
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
