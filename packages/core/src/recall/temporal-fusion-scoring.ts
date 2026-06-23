import type { MemoryEntry } from "@do-soul/alaya-protocol";
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
