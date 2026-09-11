import { z } from "zod";
import {
  ConditionalFieldSha256DigestSchema,
  SourceDeliveredSpanSchema,
  SourceEvidenceRootKindSchema,
  stableCanonicalStringify,
  type RecallTargetRef,
  type SourceDeliveredSpan,
  type SourceEvidenceTarget
} from "@do-soul/alaya-protocol";

export const MIXED_KIND_FIRST_EXPOSURE_CONTRACT = "mixed-kind-first-exposure-any-at-k-v1" as const;
export const SOURCE_GOLD_JOIN_DENOMINATOR = "source_gold_root_identity" as const;
export const HISTORICAL_MEMORY_ANY_AT_K_CONTRACT = "gold-memory-ids-any-at-k" as const;
export const HISTORICAL_MEMORY_ANY_AT_K_DENOMINATOR = "gold_memory_ids" as const;

const UnavailableMetric = z.object({
  status: z.literal("unavailable"), value: z.null(), reason: z.string()
}).strict().readonly();
const HitMetric = z.object({ status: z.literal("hit"), value: z.literal(true) }).strict().readonly();
const MissMetric = z.object({ status: z.literal("miss"), value: z.literal(false) }).strict().readonly();
export const FirstExposureBinaryMetricSchema = z.discriminatedUnion("status", [
  HitMetric, MissMetric, UnavailableMetric
]);

export const SourceGoldUnitSchema = z.object({
  workspace_id: z.string().min(1),
  root_kind: SourceEvidenceRootKindSchema,
  root_id: z.string().min(1),
  source_version: z.string().min(1),
  content_digest: ConditionalFieldSha256DigestSchema,
  span: SourceDeliveredSpanSchema.optional()
}).strict().readonly();

export const MixedKindFirstExposureMetricSchema = z.object({
  contract: z.literal(MIXED_KIND_FIRST_EXPOSURE_CONTRACT),
  denominator: z.literal(SOURCE_GOLD_JOIN_DENOMINATOR),
  gold_unit_count: z.number().int().nonnegative(),
  joined_unit_count: z.number().int().nonnegative(),
  any_at_1: FirstExposureBinaryMetricSchema,
  any_at_5: FirstExposureBinaryMetricSchema,
  any_at_10: FirstExposureBinaryMetricSchema
}).strict().readonly();

export const HistoricalMemoryAnyAtKMetricSchema = z.object({
  contract: z.literal(HISTORICAL_MEMORY_ANY_AT_K_CONTRACT),
  denominator: z.literal(HISTORICAL_MEMORY_ANY_AT_K_DENOMINATOR),
  gold_memory_id_count: z.number().int().nonnegative(),
  hit_at_1: FirstExposureBinaryMetricSchema,
  hit_at_5: FirstExposureBinaryMetricSchema,
  hit_at_10: FirstExposureBinaryMetricSchema
}).strict().readonly();

export type SourceGoldUnit = z.infer<typeof SourceGoldUnitSchema>;
export type MixedKindFirstExposureMetric = z.infer<typeof MixedKindFirstExposureMetricSchema>;
export type HistoricalMemoryAnyAtKMetric = z.infer<typeof HistoricalMemoryAnyAtKMetricSchema>;
export type FirstExposureBinaryMetric = z.infer<typeof FirstExposureBinaryMetricSchema>;

export interface FirstExposureSlot {
  readonly rank: number;
  readonly object_id?: string;
  readonly object_kind: string;
  readonly target: RecallTargetRef;
}

export function scoreMixedKindFirstExposure(
  slots: readonly FirstExposureSlot[],
  goldUnits: readonly SourceGoldUnit[]
): MixedKindFirstExposureMetric {
  if (goldUnits.length === 0) {
    const any = unavailable("source gold join not supplied");
    return {
      contract: MIXED_KIND_FIRST_EXPOSURE_CONTRACT, denominator: SOURCE_GOLD_JOIN_DENOMINATOR,
      gold_unit_count: 0, joined_unit_count: 0, any_at_1: any, any_at_5: any, any_at_10: any
    };
  }
  const joined = goldUnits.filter((unit) => slots.some((slot) => sourceSlotJoinsGold(slot, unit))).length;
  return {
    contract: MIXED_KIND_FIRST_EXPOSURE_CONTRACT, denominator: SOURCE_GOLD_JOIN_DENOMINATOR,
    gold_unit_count: goldUnits.length, joined_unit_count: joined,
    any_at_1: hitOrMiss(sourceGoldHitAt(slots, goldUnits, 1)),
    any_at_5: hitOrMiss(sourceGoldHitAt(slots, goldUnits, 5)),
    any_at_10: hitOrMiss(sourceGoldHitAt(slots, goldUnits, 10))
  };
}

export function scoreHistoricalMemoryAnyAtK(
  slots: readonly FirstExposureSlot[],
  goldMemoryIds: readonly string[] | undefined
): HistoricalMemoryAnyAtKMetric {
  if (goldMemoryIds === undefined) {
    const hit = unavailable("gold_memory_ids not supplied");
    return {
      contract: HISTORICAL_MEMORY_ANY_AT_K_CONTRACT, denominator: HISTORICAL_MEMORY_ANY_AT_K_DENOMINATOR,
      gold_memory_id_count: 0, hit_at_1: hit, hit_at_5: hit, hit_at_10: hit
    };
  }
  const gold = new Set(goldMemoryIds);
  return {
    contract: HISTORICAL_MEMORY_ANY_AT_K_CONTRACT, denominator: HISTORICAL_MEMORY_ANY_AT_K_DENOMINATOR,
    gold_memory_id_count: goldMemoryIds.length,
    hit_at_1: hitOrMiss(memoryGoldHitAt(slots, gold, 1)),
    hit_at_5: hitOrMiss(memoryGoldHitAt(slots, gold, 5)),
    hit_at_10: hitOrMiss(memoryGoldHitAt(slots, gold, 10))
  };
}

export function firstExposureJoinMismatch(input: Readonly<{
  readonly first_exposure_slots: readonly FirstExposureSlot[];
  readonly evaluated_slots: readonly FirstExposureSlot[];
  readonly source_gold_units: readonly SourceGoldUnit[];
  readonly gold_memory_ids?: readonly string[];
  readonly mixed_kind_first_exposure: MixedKindFirstExposureMetric;
  readonly historical_memory_any_at_k: HistoricalMemoryAnyAtKMetric;
}>): boolean {
  if (JSON.stringify(input.first_exposure_slots) !== JSON.stringify(input.evaluated_slots)) return true;
  return JSON.stringify(scoreMixedKindFirstExposure(input.first_exposure_slots, input.source_gold_units))
      !== JSON.stringify(input.mixed_kind_first_exposure)
    || JSON.stringify(scoreHistoricalMemoryAnyAtK(input.first_exposure_slots, input.gold_memory_ids))
      !== JSON.stringify(input.historical_memory_any_at_k);
}

function sourceGoldHitAt(
  slots: readonly FirstExposureSlot[], goldUnits: readonly SourceGoldUnit[], k: number
): boolean {
  return slots.slice(0, k).some((slot) => goldUnits.some((unit) => sourceSlotJoinsGold(slot, unit)));
}

function sourceSlotJoinsGold(slot: FirstExposureSlot, unit: SourceGoldUnit): boolean {
  return slot.target.kind === "source_evidence" && sourceGoldUnitMatches(unit, slot.target);
}

function sourceGoldUnitMatches(unit: SourceGoldUnit, target: SourceEvidenceTarget): boolean {
  // Omit evidence_object_id and memory object_id so extraction twins cannot collapse into this key.
  if (unit.workspace_id !== target.workspace_id || unit.root_kind !== target.root_kind
    || unit.root_id !== target.root_id || unit.source_version !== target.source_version
    || unit.content_digest !== target.content_digest) return false;
  return unit.span === undefined || spanEqual(unit.span, target.span);
}

function spanEqual(expected: SourceDeliveredSpan, actual: SourceDeliveredSpan | undefined): boolean {
  return actual !== undefined && stableCanonicalStringify(expected) === stableCanonicalStringify(actual);
}

function memoryGoldHitAt(
  slots: readonly FirstExposureSlot[], gold: ReadonlySet<string>, k: number
): boolean {
  return slots.slice(0, k).some((slot) => slot.object_kind === "memory_entry"
    && slot.object_id !== undefined && gold.has(slot.object_id));
}

function hitOrMiss(hit: boolean): FirstExposureBinaryMetric {
  return hit ? { status: "hit", value: true } : { status: "miss", value: false };
}

function unavailable(reason: string): FirstExposureBinaryMetric {
  return { status: "unavailable", value: null, reason };
}
