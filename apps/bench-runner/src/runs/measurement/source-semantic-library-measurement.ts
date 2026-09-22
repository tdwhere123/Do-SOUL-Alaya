import { z } from "zod";
import {
  SourceRecordIdentitySchema, type SourceRecordIdentity, RequestBudgetSchema, SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET, SOURCE_SEMANTIC_LIBRARY_RESULT_VERSION,
  SourceSemanticLibrarySlotQualifierSchema, SourceSemanticWorkerResultSchema, SoulInterpretationResponseSchema,
  canonicalJson, InformationIndexSchema, SourceSemanticLibraryProofSchema, type SourceSemanticLibraryProof, type InformationIndex, type RequestBudget, type SourceSemanticLibraryOrder,
  type SourceSemanticLibrarySlotQualifier
} from "@do-soul/alaya-protocol";
import { deliveredSourceSemanticLibraryProof, encodeSourceSemanticLibraryResults, fieldContractSha256 } from "@do-soul/alaya-core";
import {
  ExposureSlotSchema, FirstExposurePageSchema, firstExposureMismatch, exposureSlots, type FirstExposurePage
} from "./first-exposure-session.js";
import {
  MixedKindFirstExposureMetricSchema, ProofConditionedFirstExposureMetricSchema,
  SOURCE_BEARING_UNION_FIRST_EXPOSURE_CONTRACT,
  SourceGoldUnitSchema, scoreMixedKindFirstExposure, scoreProofConditionedFirstExposure,
  scoreSourceBearingUnionFirstExposure, sourceTargetJoinsGold,
  type FirstExposureSlot, type SourceBearingUnionFirstExposureMetric, type SourceGoldUnit, type UnionProofAdmission
} from "./source-gold-join.js";
import { soulSearchFromLibraryRecall } from "./source-semantic-library-recall.js";

export const SOURCE_SEMANTIC_LIBRARY_MEASUREMENT_CONTRACT = "source-semantic-library-delivered-slots-v1" as const;

const InvalidReason = z.enum([
  "invalid_response", "missing_zero_call_evidence", "missing_request_budget", "request_budget_mismatch",
  "missing_first_exposure", "slot_qualifier_mismatch", "unusable_source_state"
]);
const usableLogicalStates = new Set(["complete", "partial", "open", "exhausted_empty"]);
const usableObservedStates = new Set(["complete", "partial", "open", "exhausted_empty", "unknown"]);

const ValidatedMeasurement = z.object({
  schema_version: z.literal(1), status: z.literal("validated"),
  contract: z.literal(SOURCE_SEMANTIC_LIBRARY_MEASUREMENT_CONTRACT),
  request: z.object({ budget: RequestBudgetSchema }).strict().readonly(),
  effective_page_budget: z.literal(SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET),
  delivered_index: InformationIndexSchema,
  delivered_proofs: z.array(SourceSemanticLibraryProofSchema).readonly(),
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
  }).strict().readonly()
}).strict().readonly().superRefine((value, context) => {
  if (!librarySlotsMatchIndex(value.first_exposure_slots, value.delivered_index, value.slot_qualifiers)) {
    context.addIssue({ code: "custom", message: "library delivered slots differ from native index" });
    return;
  }
  const proofRanks = proofRanksFromLibrary(value.first_exposure_slots, value.delivered_index,
    value.slot_qualifiers, value.delivered_proofs, value.source_records ?? [], value.request.budget);
  const mixed = scoreMixedKindFirstExposure(value.first_exposure_slots, value.source_gold_units);
  const proof = proofMetric(value.first_exposure_slots, value.source_gold_units, proofRanks);
  const slotsMatch = JSON.stringify(value.first_exposure_slots)
    === JSON.stringify(value.first_exposure_page.initial?.slots ?? []);
  const { result_version, ...identity } = value.identity;
  const nativeIdentity = { query_id: value.delivered_index.query_id, snapshot_id: value.delivered_index.snapshot_id,
    interpretation_id: value.delivered_index.interpretation_id, as_of: value.delivered_index.as_of };
  if (canonicalJson(identity) !== canonicalJson(nativeIdentity)
    || result_version !== value.delivered_index.result_version
    || firstExposureMismatch(value.first_exposure_page, identity, value.first_exposure_slots, value.first_exposure_page.delivery_id)
    || value.first_exposure_page.request_continuation !== null
    || !slotsMatch
    || JSON.stringify(mixed) !== JSON.stringify(value.metrics.mixed_kind_first_exposure)
    || JSON.stringify(proof) !== JSON.stringify(value.metrics.proof_conditioned_first_exposure)) {
    context.addIssue({ code: "custom", message: "library measurement slot join is inconsistent" });
  }
});

export const SourceSemanticLibraryMeasurementSchema = z.discriminatedUnion("status", [
  ValidatedMeasurement,
  z.object({ schema_version: z.literal(1), status: z.literal("invalid"), reason: InvalidReason }).strict().readonly()
]);
export type SourceSemanticLibraryMeasurement = z.infer<typeof SourceSemanticLibraryMeasurementSchema>;
type InvalidMeasurementReason = Extract<SourceSemanticLibraryMeasurement, { status: "invalid" }>["reason"];

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
  readonly order: SourceSemanticLibraryOrder;
  readonly slot_qualifiers: readonly SourceSemanticLibrarySlotQualifier[];
  readonly proofs?: readonly SourceSemanticLibraryProof[];
  readonly request_budget?: RequestBudget;
  readonly results?: Parameters<typeof soulSearchFromLibraryRecall>[0]["results"];
  readonly total_count?: number;
  readonly previews?: Readonly<Record<string, string>>;
}

/** Public MCP/worker library recall into mixed-kind and proof-conditioned Any@K. Never a CF execution receipt. */
export function measureSourceSemanticLibraryResponse(
  input: SourceSemanticLibraryMeasurementInput
): SourceSemanticLibraryMeasurement | null {
  const admitted = admitLibraryMeasurement(input);
  if (admitted === null || admitted.status === "invalid") return admitted;
  const gold = SourceGoldUnitSchema.array().readonly().safeParse(input.goldSourceUnits);
  if (!gold.success) return invalid("invalid_response");
  const mixed = scoreMixedKindFirstExposure(admitted.slots, gold.data);
  const proof = proofMetric(admitted.slots, gold.data, admitted.proofRanks);
  const validated = ValidatedMeasurement.safeParse({
    schema_version: 1, status: "validated", contract: SOURCE_SEMANTIC_LIBRARY_MEASUREMENT_CONTRACT,
    request: { budget: admitted.budget }, identity: admitted.identity,
    effective_page_budget: SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET, delivered_index: admitted.index, delivered_proofs: admitted.proofs,
    ...(input.sourceRecords === undefined ? {} : { source_records: input.sourceRecords }),
    first_exposure_page: admitted.exposure, first_exposure_slots: admitted.slots,
    slot_qualifiers: admitted.qualifiers, source_gold_units: gold.data, provider_calls: 0,
    metrics: { mixed_kind_first_exposure: mixed, proof_conditioned_first_exposure: proof }
  });
  return validated.success ? validated.data : invalid("invalid_response");
}

function admitLibraryMeasurement(
  input: SourceSemanticLibraryMeasurementInput
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
  readonly proofRanks: ReadonlySet<number> | null;
  readonly index: InformationIndex; readonly proofs: readonly SourceSemanticLibraryProof[];
} | Extract<SourceSemanticLibraryMeasurement, { status: "invalid" }> | null {
  if (!isRecord(input.recallResult)) return null;
  const zeroCall = zeroCallReason(input.recallResult);
  if (zeroCall !== null) return invalid(zeroCall);
  const recalled = parseLibraryRecall(input.recallResult);
  if (recalled === null) return null;
  if (recalled === "invalid") return invalid("invalid_response");
  const budget = RequestBudgetSchema.safeParse(input.requestBudget);
  if (!budget.success) return invalid("missing_request_budget");
  if (recalled.order.page_budget !== SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET
    || recalled.index.representation.page_budget !== SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET) {
    return invalid("request_budget_mismatch");
  }
  if (recalled.request_budget === undefined) return invalid("missing_request_budget");
  if (canonicalJson(recalled.request_budget) !== canonicalJson(budget.data)) return invalid("request_budget_mismatch");
  const index = recalled.index;
  if (index.interpretation_id === undefined || index.as_of === undefined) return invalid("missing_first_exposure");
  if (!usableLogicalStates.has(index.completeness.logical_index)
    || !observedCoverageUsable(index.completeness.observed_coverage, index.completeness.logical_index, index.entries.length)
    || index.entries.length > SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET) {
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
  if (!exposure.success || firstExposureMismatch(exposure.data, {
    query_id: index.query_id, snapshot_id: index.snapshot_id,
    interpretation_id: index.interpretation_id, as_of: index.as_of
  }, slots, search.delivery_id)) return invalid("missing_first_exposure");
  const proofRanks = proofRanksFromLibrary(slots, index, recalled.slot_qualifiers, recalled.proofs ?? [], input.sourceRecords ?? [], budget.data);
  return {
    status: "admitted", budget: budget.data, index, proofs: recalled.proofs ?? [], exposure: exposure.data, slots, qualifiers: recalled.slot_qualifiers,
    proofRanks, identity: {
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
      previews: worker.data.previews, proofs: worker.data.proofs, request_budget: worker.data.request_budget
    };
  }
  const mcp = SoulInterpretationResponseSchema.safeParse(raw);
  if (mcp.success) {
    if (mcp.data.operation !== "recall") return null;
    if (mcp.data.index === undefined || mcp.data.order === undefined || mcp.data.results === undefined || mcp.data.total_count === undefined
      || mcp.data.slot_qualifiers === undefined || mcp.data.delivery_id === undefined) {
      return looksLikeLibraryRecall(raw) ? "invalid" : null;
    }
    return {
      delivery_id: mcp.data.delivery_id, index: mcp.data.index, order: mcp.data.order,
      slot_qualifiers: mcp.data.slot_qualifiers, proofs: mcp.data.proofs, request_budget: mcp.data.request_budget, results: mcp.data.results, total_count: mcp.data.total_count
    };
  }
  return looksLikeLibraryRecall(raw) ? "invalid" : null;
}

function looksLikeLibraryRecall(raw: Record<string, unknown>): boolean {
  if (raw.kind === "recall" || raw.operation === "recall") return true;
  return isRecord(raw.index) && raw.index.result_version === SOURCE_SEMANTIC_LIBRARY_RESULT_VERSION;
}

function proofRanksFromLibrary(
  slots: readonly z.infer<typeof ExposureSlotSchema>[],
  index: InformationIndex,
  qualifiers: readonly SourceSemanticLibrarySlotQualifier[], proofs: readonly SourceSemanticLibraryProof[],
  sourceRecords: readonly SourceRecordIdentity[], verificationBudget: RequestBudget
): ReadonlySet<number> | null {
  const ranks = new Set<number>();
  for (const slot of slots) {
    const entry = index.entries[slot.index_entry_offset]!;
    const qualifier = qualifiers[slot.index_entry_offset]!;
    if (qualifier.evidence_kind === "semantic_proof") {
      if (deliveredSourceSemanticLibraryProof(index, entry, qualifier, proofs,
        sourceRecords.find((record) => entry.target.kind === "source_evidence" && record.identity === entry.target.root_id
          && record.workspace_id === entry.target.workspace_id), verificationBudget) === undefined) return null;
      ranks.add(slot.rank);
    }
  }
  return ranks;
}

export function sourceSemanticLibraryProofAdmission(
  slots: readonly z.infer<typeof ExposureSlotSchema>[], index: InformationIndex,
  qualifiers: readonly SourceSemanticLibrarySlotQualifier[], proofs: readonly SourceSemanticLibraryProof[],
  gold: readonly SourceGoldUnit[], sourceRecords: readonly SourceRecordIdentity[], verificationBudget: RequestBudget
): UnionProofAdmission {
  const validatedRanks = new Set<number>();
  const unverifiedGoldRanks = new Set<number>();
  if (!librarySlotsMatchIndex(slots, index, qualifiers)) return { status: "invalid", validatedRanks, unverifiedGoldRanks };
  for (const slot of slots) {
    if (slot.object_kind !== "semantic_proof") continue;
    const entry = index.entries[slot.index_entry_offset]!;
    const qualifier = qualifiers[slot.index_entry_offset]!;
    const delivered = deliveredSourceSemanticLibraryProof(index, entry, qualifier, proofs,
        sourceRecords.find((record) => entry.target.kind === "source_evidence" && record.identity === entry.target.root_id
          && record.workspace_id === entry.target.workspace_id), verificationBudget) !== undefined;
    if (delivered) validatedRanks.add(slot.rank);
    else if (gold.some((unit) => sourceTargetJoinsGold(slot, unit))) unverifiedGoldRanks.add(slot.rank);
  }
  return { status: "admitted", validatedRanks, unverifiedGoldRanks };
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
