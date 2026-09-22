import { z } from "zod";
import {
  SourceRecordIdentitySchema, type SourceRecordIdentity, RequestBudgetSchema, SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET, SOURCE_SEMANTIC_LIBRARY_RESULT_VERSION,
  SourceSemanticLibrarySlotQualifierSchema, SourceSemanticWorkerResultSchema, SoulInterpretationResponseSchema,
  SoulInterpretationRecallDeliverySchema, SourceSemanticLibraryDiscoverySchema, SourceSemanticCoverageSchema,
  canonicalJson, InformationIndexSchema, ContinuationSchema, MemorySearchResultSchema, SourceSemanticLibraryProofSchema, type SourceSemanticLibraryProof, type InformationIndex, type RequestBudget, type SourceSemanticLibraryOrder,
  type SourceSemanticLibrarySlotQualifier
} from "@do-soul/alaya-protocol";
import { deliveredSourceSemanticLibraryProof, encodeSourceSemanticLibraryResults } from "@do-soul/alaya-core";
import {
  ExposureSlotSchema, FirstExposurePageSchema, firstExposureMismatch, exposureSlots, type FirstExposurePage
} from "./first-exposure-session.js";
import {
  MixedKindFirstExposureMetricSchema, ProofConditionedFirstExposureMetricSchema,
  SourceGoldUnitSchema, scoreMixedKindFirstExposure, scoreProofConditionedFirstExposure,
  scoreSourceBearingUnionFirstExposure, sourceTargetJoinsGold, SourceBearingUnionFirstExposureMetricSchema,
  type SourceBearingUnionFirstExposureMetric, type SourceGoldUnit, type UnionProofAdmission
} from "./source-gold-join.js";
import { soulSearchFromLibraryRecall } from "./source-semantic-library-recall.js";

export const SOURCE_SEMANTIC_LIBRARY_MEASUREMENT_CONTRACT = "source-semantic-library-delivered-slots-v2" as const;
const HISTORICAL_SOURCE_ONLY_PAGE_BUDGET = 10;

const InvalidReason = z.enum([
  "invalid_response", "missing_zero_call_evidence", "missing_request_budget", "request_budget_mismatch",
  "missing_first_exposure", "slot_qualifier_mismatch", "unusable_source_state"
]);
const usableLogicalStates = new Set(["complete", "partial", "open", "exhausted_empty"]);
const usableObservedStates = new Set(["complete", "partial", "open", "exhausted_empty", "unknown"]);

const ValidatedMeasurementRecord = z.object({
  schema_version: z.literal(1), status: z.literal("validated"),
  contract: z.literal(SOURCE_SEMANTIC_LIBRARY_MEASUREMENT_CONTRACT),
  request: z.object({ budget: RequestBudgetSchema }).strict().readonly(),
  effective_page_budget: z.literal(SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET),
  delivered_index: InformationIndexSchema,
  delivered_proofs: z.array(SourceSemanticLibraryProofSchema).readonly(),
  native_observation: z.object({ discovery: SourceSemanticLibraryDiscoverySchema,
    coverage: SourceSemanticCoverageSchema }).strict().readonly(),
  source_records: z.array(SourceRecordIdentitySchema).readonly().optional(),
  identity: z.object({
    query_id: z.string(), snapshot_id: z.string(), interpretation_id: z.string().min(1),
    as_of: z.string().min(1), result_version: z.string()
  }).strict().readonly(),
  first_exposure_page: FirstExposurePageSchema,
  first_exposure_slots: z.array(ExposureSlotSchema).readonly(),
  slot_qualifiers: z.array(SourceSemanticLibrarySlotQualifierSchema).readonly(),
  source_gold_units: z.array(SourceGoldUnitSchema).readonly(),
  provider_calls: z.literal(0),
  metrics: z.object({
    mixed_kind_first_exposure: MixedKindFirstExposureMetricSchema,
    proof_conditioned_first_exposure: ProofConditionedFirstExposureMetricSchema,
    delivered_slot_union: SourceBearingUnionFirstExposureMetricSchema,
  }).strict().readonly()
}).strict().readonly();
const HistoricalValidatedMeasurementRecord = ValidatedMeasurementRecord.unwrap().omit({ native_observation: true }).extend({
  contract: z.literal("source-semantic-library-delivered-slots-v1"),
  effective_page_budget: z.literal(HISTORICAL_SOURCE_ONLY_PAGE_BUDGET),
  metrics: ValidatedMeasurementRecord.unwrap().shape.metrics.unwrap().omit({ delivered_slot_union: true }).readonly()
}).readonly();
type ValidatedMeasurement = z.infer<typeof ValidatedMeasurementRecord | typeof HistoricalValidatedMeasurementRecord>;

function recordInconsistency(value: ValidatedMeasurement): string | undefined {
  if (!librarySlotsMatchIndex(value.first_exposure_slots, value.delivered_index, value.slot_qualifiers)) {
    return "library delivered slots differ from native index";
  }
  const slotsMatch = JSON.stringify(value.first_exposure_slots)
    === JSON.stringify(value.first_exposure_page.initial?.slots ?? []);
  const { result_version, ...identity } = value.identity;
  const nativeIdentity = { query_id: value.delivered_index.query_id, snapshot_id: value.delivered_index.snapshot_id,
    interpretation_id: value.delivered_index.interpretation_id, as_of: value.delivered_index.as_of };
  if (canonicalJson(identity) !== canonicalJson(nativeIdentity)
    || result_version !== value.delivered_index.result_version
    || firstExposureMismatch(value.first_exposure_page, identity, value.first_exposure_slots, value.first_exposure_page.delivery_id)
    || value.first_exposure_page.request_continuation !== null
    || !slotsMatch) return "library measurement slot join is inconsistent";
  return undefined;
}

const MeasurementRecordSchema = z.discriminatedUnion("status", [
  ValidatedMeasurementRecord,
  z.object({ schema_version: z.literal(1), status: z.literal("invalid"), reason: InvalidReason }).strict().readonly()
]);
export type SourceSemanticLibraryMeasurement = z.infer<typeof MeasurementRecordSchema> | z.infer<typeof HistoricalValidatedMeasurementRecord>;
type InvalidMeasurementReason = Extract<SourceSemanticLibraryMeasurement, { status: "invalid" }>["reason"];

export interface SourceSemanticLibraryEvaluatorUsage {
  readonly proof_slots_checked: number;
  readonly work_units: number;
  /** Sum of conservative logical allocation charges, not peak memory or RSS. */
  readonly logical_memory_bytes: number;
}
export interface SourceSemanticLibraryEvaluation {
  readonly measurement: SourceSemanticLibraryMeasurement | null;
  readonly sourceBearingUnion: SourceBearingUnionFirstExposureMetric | null;
  readonly validatedProofRanks: readonly number[];
  readonly evaluator_usage: SourceSemanticLibraryEvaluatorUsage;
}
const EMPTY_EVALUATOR_USAGE = { proof_slots_checked: 0, work_units: 0, logical_memory_bytes: 0 } as const;

export interface SourceSemanticLibraryMeasurementInput {
  readonly recallResult: unknown;
  readonly firstExposurePage: FirstExposurePage;
  readonly requestBudget: RequestBudget;
  readonly goldSourceUnits: readonly SourceGoldUnit[];
  /** Current native snapshot records, supplied by the measurement owner independently of proof claims. */
  readonly sourceRecords?: readonly SourceRecordIdentity[];
}

interface LibraryRecall {
  readonly delivery_id: string;
  readonly index: InformationIndex;
  readonly order: SourceSemanticLibraryOrder | z.infer<typeof HistoricalSourceOnlyDeliverySchema>["order"];
  readonly slot_qualifiers: readonly SourceSemanticLibrarySlotQualifier[];
  readonly proofs?: readonly SourceSemanticLibraryProof[];
  readonly request_budget?: RequestBudget;
  readonly results?: Parameters<typeof soulSearchFromLibraryRecall>[0]["results"];
  readonly total_count?: number;
  readonly previews?: Readonly<Record<string, string>>;
  readonly discovery: z.infer<typeof SourceSemanticLibraryDiscoverySchema>;
  readonly coverage: z.infer<typeof SourceSemanticCoverageSchema>;
}

/** One native admission supplies all metrics and a separate fresh evaluator cost. Never a CF execution receipt. */
export function measureSourceSemanticLibraryResponse(
  input: SourceSemanticLibraryMeasurementInput
): SourceSemanticLibraryEvaluation {
  return measureLibraryDelivery(input, isRecord(input.recallResult) ? parseLibraryRecall(input.recallResult) : null);
}

function measureLibraryDelivery(input: SourceSemanticLibraryMeasurementInput,
  recalled: LibraryRecall | "invalid" | null, historicalSourceOnly = false): SourceSemanticLibraryEvaluation {
  const pageBudget = historicalSourceOnly ? HISTORICAL_SOURCE_ONLY_PAGE_BUDGET : SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET;
  const admitted = admitLibraryMeasurement(input, recalled, pageBudget);
  if (admitted === null || admitted.status === "invalid") return unavailableEvaluation(admitted);
  const gold = SourceGoldUnitSchema.array().readonly().safeParse(input.goldSourceUnits);
  const records = SourceRecordIdentitySchema.array().readonly().safeParse(input.sourceRecords ?? []);
  if (!gold.success || !records.success) return unavailableEvaluation(invalid("invalid_response"));
  const assessment = assessDeliveredProofSlots(admitted.slots, admitted.index, admitted.qualifiers, admitted.proofs,
    gold.data, records.data, admitted.budget);
  const deliveredSlotUnion = scoreSourceBearingUnionFirstExposure(admitted.slots, gold.data, assessment.unionAdmission);
  const validated = (historicalSourceOnly ? HistoricalValidatedMeasurementRecord : ValidatedMeasurementRecord).safeParse({
    schema_version: 1, status: "validated", contract: historicalSourceOnly
      ? "source-semantic-library-delivered-slots-v1" : SOURCE_SEMANTIC_LIBRARY_MEASUREMENT_CONTRACT,
    request: { budget: admitted.budget }, identity: admitted.identity,
    effective_page_budget: pageBudget, delivered_index: admitted.index, delivered_proofs: admitted.proofs,
    ...(input.sourceRecords === undefined ? {} : { source_records: input.sourceRecords }),
    first_exposure_page: admitted.exposure, first_exposure_slots: admitted.slots,
    slot_qualifiers: admitted.qualifiers, source_gold_units: gold.data, provider_calls: 0,
    ...(historicalSourceOnly ? {} : { native_observation: admitted.observation }),
    metrics: { ...measurementMetrics(admitted.slots, gold.data, assessment),
      ...(historicalSourceOnly ? {} : { delivered_slot_union: deliveredSlotUnion }) }
  });
  if (!validated.success || recordInconsistency(validated.data) !== undefined) {
    return unavailableEvaluation(invalid("invalid_response"), assessment.evaluator_usage);
  }
  return { measurement: validated.data, evaluator_usage: assessment.evaluator_usage,
    validatedProofRanks: [...assessment.unionAdmission.validatedRanks],
    sourceBearingUnion: resolveNativeUnion(deliveredSlotUnion, admitted.observation) };
}

/** A delivered positive is observed; a negative cannot close native unvisited or unfinished work.
 * Index pagination and unsupported client computation alone do not imply unvisited access. */
function resolveNativeUnion(metric: SourceBearingUnionFirstExposureMetric,
  observation: z.infer<typeof ValidatedMeasurementRecord>["native_observation"]): SourceBearingUnionFirstExposureMetric {
  const { discovery, coverage } = observation;
  if (!discovery.open_residuals && !discovery.truncated && coverage.discovery === "complete"
    && !discovery.access?.unvisited_sources && !discovery.access?.unvisited_interpretations) return metric;
  const resolve = (value: SourceBearingUnionFirstExposureMetric["any_at_5"]) => value.status !== "miss" ? value
    : { status: "unavailable" as const, value: null, reason: "native access or computation remains unresolved" };
  return { ...metric, any_at_1: resolve(metric.any_at_1), any_at_5: resolve(metric.any_at_5), any_at_10: resolve(metric.any_at_10) };
}

/** Archive shape is not admission. Bind its recorded source subset to independent publication records, then evaluate once. */
export function readmitSourceSemanticLibraryMeasurement(rawMeasurement: unknown,
  input: SourceSemanticLibraryMeasurementInput): SourceSemanticLibraryEvaluation {
  return readmitLibraryDelivery(rawMeasurement, input, isRecord(input.recallResult) ? parseLibraryRecall(input.recallResult) : null);
}

// Offline source-only v1 evidence retains its original index/query/exposure identities.
// Its canonical ten-slot tuple is historical; unchanged field schemas and complete-delivery checks reuse Protocol.
const HistoricalSourceOnlyDeliverySchema = SoulInterpretationRecallDeliverySchema.omit({ request_identity: true }).extend({
  protocol_version: z.literal(1),
  index: SoulInterpretationRecallDeliverySchema.shape.index.unwrap().extend({
    result_version: z.literal("source-semantic-library-v1"),
    continuation: ContinuationSchema.unwrap().extend({ result_version: z.literal("source-semantic-library-v1"),
      enumeration_policy: z.literal("canonical").optional() }).readonly().nullable(),
    representation: InformationIndexSchema.unwrap().shape.representation.unwrap().extend({
      page_budget: z.literal(HISTORICAL_SOURCE_ONLY_PAGE_BUDGET)
    }).readonly()
  }).readonly(),
  order: SoulInterpretationRecallDeliverySchema.shape.order.unwrap().extend({
    enumeration_policy: z.literal("canonical"), page_budget: z.literal(HISTORICAL_SOURCE_ONLY_PAGE_BUDGET)
  }).readonly(),
  slot_qualifiers: z.array(SourceSemanticLibrarySlotQualifierSchema).max(HISTORICAL_SOURCE_ONLY_PAGE_BUDGET).readonly(),
  results: z.array(MemorySearchResultSchema).max(HISTORICAL_SOURCE_ONLY_PAGE_BUDGET).readonly()
}).refine((delivery) => (delivery.proofs?.length ?? 0) === 0
  && delivery.slot_qualifiers.every((slot) => slot.evidence_kind === "source_evidence"),
  "historical comparison requires source-only delivery");

/** Explicit archive entry only; the native reader never falls back to a historical contract. */
export function readmitHistoricalSourceOnlyLibraryMeasurement(rawMeasurement: unknown,
  input: SourceSemanticLibraryMeasurementInput): SourceSemanticLibraryEvaluation {
  const recalled = HistoricalSourceOnlyDeliverySchema.safeParse(input.recallResult);
  return readmitLibraryDelivery(rawMeasurement, input, recalled.success ? recalled.data : "invalid", true);
}

function readmitLibraryDelivery(rawMeasurement: unknown, input: SourceSemanticLibraryMeasurementInput,
  recalled: LibraryRecall | "invalid" | null, historicalSourceOnly = false): SourceSemanticLibraryEvaluation {
  const stored = (historicalSourceOnly ? HistoricalValidatedMeasurementRecord : ValidatedMeasurementRecord).safeParse(rawMeasurement);
  if (!stored.success || recordInconsistency(stored.data) !== undefined
    || (stored.data.source_records ?? []).some((record) => !(input.sourceRecords ?? []).some((trusted) =>
      trusted.scope_class != null && canonicalJson(record) === canonicalJson(trusted)))) {
    return unavailableEvaluation(invalid("invalid_response"));
  }
  const { sourceRecords: _records, ...nativeInput } = input;
  const evaluated = measureLibraryDelivery({ ...nativeInput,
    ...(stored.data.source_records === undefined ? {} : { sourceRecords: stored.data.source_records }) }, recalled, historicalSourceOnly);
  return canonicalJson(evaluated.measurement) === canonicalJson(stored.data) ? evaluated
    : unavailableEvaluation(invalid("invalid_response"), evaluated.evaluator_usage);
}

function unavailableEvaluation(measurement: SourceSemanticLibraryMeasurement | null,
  evaluator_usage: SourceSemanticLibraryEvaluatorUsage = EMPTY_EVALUATOR_USAGE): SourceSemanticLibraryEvaluation {
  return { measurement, evaluator_usage, sourceBearingUnion: null, validatedProofRanks: [] };
}

function admitLibraryMeasurement(
  input: SourceSemanticLibraryMeasurementInput, recalled: LibraryRecall | "invalid" | null, pageBudget: number
): {
  readonly status: "admitted";
  readonly budget: RequestBudget;
  readonly identity: {
    readonly query_id: string; readonly snapshot_id: string; readonly interpretation_id: string;
    readonly as_of: string; readonly result_version: string;
  };
  readonly exposure: FirstExposurePage;
  readonly slots: z.infer<typeof ExposureSlotSchema>[];
  readonly qualifiers: readonly SourceSemanticLibrarySlotQualifier[];
  readonly index: InformationIndex; readonly proofs: readonly SourceSemanticLibraryProof[];
  readonly observation: z.infer<typeof ValidatedMeasurementRecord>["native_observation"];
} | Extract<SourceSemanticLibraryMeasurement, { status: "invalid" }> | null {
  if (!isRecord(input.recallResult)) return null;
  const zeroCall = zeroCallReason(input.recallResult);
  if (zeroCall !== null) return invalid(zeroCall);
  if (recalled === null) return null;
  if (recalled === "invalid") return invalid("invalid_response");
  const budget = RequestBudgetSchema.safeParse(input.requestBudget);
  if (!budget.success) return invalid("missing_request_budget");
  if (recalled.request_budget === undefined) return invalid("missing_request_budget");
  if (canonicalJson(recalled.request_budget) !== canonicalJson(budget.data)) return invalid("request_budget_mismatch");
  const index = recalled.index;
  if (index.interpretation_id === undefined || index.as_of === undefined) return invalid("missing_first_exposure");
  if (!usableLogicalStates.has(index.completeness.logical_index)
    || !observedCoverageUsable(index.completeness.observed_coverage, index.completeness.logical_index, index.entries.length)
    || index.entries.length > pageBudget) {
    return invalid("unusable_source_state");
  }
  const search = soulSearchFromLibraryRecall({
    delivery_id: recalled.delivery_id, index, results: recalled.results,
    total_count: recalled.total_count, previews: recalled.previews
  });
  const slots = exposureSlots(search);
  if (search.results.length !== index.entries.length || search.total_count !== search.results.length
    || !librarySlotsMatchIndex(slots, index, recalled.slot_qualifiers)) return invalid("slot_qualifier_mismatch");
  const exposure = FirstExposurePageSchema.safeParse(input.firstExposurePage);
  if (!exposure.success || exposure.data.request_continuation !== null || firstExposureMismatch(exposure.data, {
    query_id: index.query_id, snapshot_id: index.snapshot_id,
    interpretation_id: index.interpretation_id, as_of: index.as_of
  }, slots, search.delivery_id)) return invalid("missing_first_exposure");
  return {
    status: "admitted", budget: budget.data, index, proofs: recalled.proofs ?? [], exposure: exposure.data, slots, qualifiers: recalled.slot_qualifiers,
    observation: { discovery: recalled.discovery, coverage: recalled.coverage },
    identity: {
      query_id: index.query_id, snapshot_id: index.snapshot_id, interpretation_id: index.interpretation_id,
      as_of: index.as_of, result_version: index.result_version
    }
  };
}

function parseLibraryRecall(raw: Record<string, unknown>): LibraryRecall | "invalid" | null {
  const worker = SourceSemanticWorkerResultSchema.safeParse(raw);
  if (worker.success) {
    if (worker.data.kind !== "recall") return null;
    return {
      delivery_id: worker.data.delivery_id, index: worker.data.index, order: worker.data.order,
      slot_qualifiers: worker.data.slot_qualifiers, total_count: worker.data.total_count,
      previews: worker.data.previews, proofs: worker.data.proofs, request_budget: worker.data.request_budget,
      discovery: worker.data.discovery, coverage: worker.data.coverage
    };
  }
  const mcp = SoulInterpretationResponseSchema.safeParse(raw);
  if (mcp.success) {
    if (mcp.data.operation !== "recall") return null;
    if (mcp.data.index === undefined) return null; // Protocol admitted an outcome-only response, not an empty delivery.
    if (mcp.data.index === undefined || mcp.data.order === undefined || mcp.data.results === undefined || mcp.data.total_count === undefined
      || mcp.data.slot_qualifiers === undefined || mcp.data.delivery_id === undefined || mcp.data.discovery === undefined) {
      return looksLikeLibraryRecall(raw) ? "invalid" : null;
    }
    return {
      delivery_id: mcp.data.delivery_id, index: mcp.data.index, order: mcp.data.order,
      slot_qualifiers: mcp.data.slot_qualifiers, proofs: mcp.data.proofs, request_budget: mcp.data.request_budget, results: mcp.data.results, total_count: mcp.data.total_count,
      discovery: mcp.data.discovery, coverage: mcp.data.coverage
    };
  }
  return looksLikeLibraryRecall(raw) ? "invalid" : null;
}

function looksLikeLibraryRecall(raw: Record<string, unknown>): boolean {
  if (raw.kind === "recall" || raw.operation === "recall") return true;
  return isRecord(raw.index) && raw.index.result_version === SOURCE_SEMANTIC_LIBRARY_RESULT_VERSION;
}

function assessDeliveredProofSlots(
  slots: readonly z.infer<typeof ExposureSlotSchema>[], index: InformationIndex,
  qualifiers: readonly SourceSemanticLibrarySlotQualifier[], proofs: readonly SourceSemanticLibraryProof[],
  gold: readonly SourceGoldUnit[], sourceRecords: readonly SourceRecordIdentity[], verificationBudget: RequestBudget
): { legacyProofRanks: ReadonlySet<number> | null; unionAdmission: UnionProofAdmission; evaluator_usage: SourceSemanticLibraryEvaluatorUsage } {
  const validatedRanks = new Set<number>();
  const unverifiedGoldRanks = new Set<number>();
  const usage = { proof_slots_checked: 0, work_units: 0, logical_memory_bytes: 0 };
  let allVerified = true;
  for (const slot of slots) {
    if (slot.object_kind !== "semantic_proof") continue;
    const entry = index.entries[slot.index_entry_offset]!;
    const qualifier = qualifiers[slot.index_entry_offset]!;
    const delivered = deliveredSourceSemanticLibraryProof(index, entry, qualifier, proofs,
        sourceRecords.find((record) => entry.target.kind === "source_evidence" && record.identity === entry.target.root_id
          && record.workspace_id === entry.target.workspace_id), verificationBudget);
    usage.proof_slots_checked += 1;
    usage.work_units += delivered.resource_usage.work_units;
    usage.logical_memory_bytes += delivered.resource_usage.memory_bytes;
    if (delivered.proof !== undefined) validatedRanks.add(slot.rank);
    else {
      allVerified = false;
      if (gold.some((unit) => sourceTargetJoinsGold(slot, unit))) unverifiedGoldRanks.add(slot.rank);
    }
  }
  return { legacyProofRanks: allVerified ? validatedRanks : null, evaluator_usage: usage,
    unionAdmission: { status: "admitted", validatedRanks, unverifiedGoldRanks } };
}

function measurementMetrics(slots: readonly z.infer<typeof ExposureSlotSchema>[], gold: readonly SourceGoldUnit[],
  assessment: ReturnType<typeof assessDeliveredProofSlots>) {
  return { mixed_kind_first_exposure: scoreMixedKindFirstExposure(slots, gold),
    proof_conditioned_first_exposure: proofMetric(slots, gold, assessment.legacyProofRanks) };
}

/** Native encoding owns slot identity and ordering; proof verification starts only after this whole-page admission. */
function librarySlotsMatchIndex(slots: readonly z.infer<typeof ExposureSlotSchema>[], index: InformationIndex,
  qualifiers: readonly SourceSemanticLibrarySlotQualifier[]): boolean {
  const native = exposureSlots({ results: encodeSourceSemanticLibraryResults(index) });
  return slots.length === index.entries.length && qualifiers.length === slots.length
    && canonicalJson(slots) === canonicalJson(native)
    && qualifiers.every((qualifier, offset) => qualifier.index === offset && qualifier.evidence_kind === native[offset]?.object_kind);
}

function proofMetric(slots: readonly z.infer<typeof ExposureSlotSchema>[], gold: readonly SourceGoldUnit[],
  ranks: ReadonlySet<number> | null) {
  const metric = scoreProofConditionedFirstExposure(slots, gold, ranks ?? new Set());
  if (ranks !== null) return metric;
  const unavailable = { status: "unavailable" as const, value: null, reason: "delivered conditional proof is missing, inconsistent or not verified within budget" };
  return { ...metric, any_at_1: unavailable, any_at_5: unavailable, any_at_10: unavailable };
}

function zeroCallReason(raw: Record<string, unknown>): InvalidMeasurementReason | null {
  if (Object.hasOwn(raw, "provider_calls") && raw.provider_calls !== 0) return "missing_zero_call_evidence";
  if (Object.hasOwn(raw, "provider_attempts") && raw.provider_attempts !== 0) return "missing_zero_call_evidence";
  if (Object.hasOwn(raw, "garden_enqueue") && raw.garden_enqueue !== 0) return "missing_zero_call_evidence";
  return null;
}

function observedCoverageUsable(observed: string, logical: string, entryCount: number): boolean {
  if (observed === "unknown") {
    return entryCount > 0 && logical !== "complete" && logical !== "exhausted_empty";
  }
  return usableObservedStates.has(observed);
}

function invalid(reason: InvalidMeasurementReason): Extract<SourceSemanticLibraryMeasurement, { status: "invalid" }> {
  return { schema_version: 1, status: "invalid", reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
