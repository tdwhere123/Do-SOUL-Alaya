import { describe, expect, it } from "vitest";
import { compileConditionalFieldQuery, interpretationIdentity } from "@do-soul/alaya-core";
import {
  InformationIndexSchema,
  sourceProductStateKey,
  type MemorySearchResult,
  type RecallTargetRef
} from "@do-soul/alaya-protocol";
import { buildQuestionDiagnostic } from "../../../diagnostics/diagnostics-question.js";
import type { QuestionDiagnosticInput } from "../../../diagnostics/question-assembly.js";
import {
  HISTORICAL_MEMORY_ANY_AT_K_CONTRACT,
  HISTORICAL_MEMORY_ANY_AT_K_DENOMINATOR,
  MIXED_KIND_FIRST_EXPOSURE_CONTRACT,
  SOURCE_GOLD_JOIN_DENOMINATOR,
  measureConditionalFieldResponse,
  type SourceGoldUnit
} from "../../../runs/measurement/conditional-field-measurement.js";

const NOW = "2026-09-08T00:00:00.000Z";
const SNAPSHOT = `sha256:${"a".repeat(64)}`;
const DIGEST = `sha256:${"d".repeat(64)}`;
const BUDGET = { schema_version: 1 as const, work_units: 10000, memory_bytes: 1000000,
  page_budget: 10, finalization_reserve: 100, min_envelope: 10 };

const SOURCE_GOLD: SourceGoldUnit = {
  workspace_id: "workspace", root_kind: "source_record", root_id: "rec-1",
  source_version: "v1", content_digest: DIGEST
};

function sourceTarget(overrides: Partial<Extract<RecallTargetRef, { kind: "source_evidence" }>> = {}): RecallTargetRef {
  return { kind: "source_evidence", workspace_id: "workspace", root_kind: "source_record",
    root_id: "rec-1", source_version: "v1", content_digest: DIGEST, evidence_object_id: null, ...overrides };
}

function memoryTarget(object_id = "extracted-twin"): RecallTargetRef {
  return { kind: "memory_entry", workspace_id: "workspace", object_id, source_revision: "rev" };
}

function fixture(targets: readonly RecallTargetRef[]) {
  const compile_input = { source: "ordinary" as const, text: "deployment checklist",
    snapshot_id: SNAPSHOT, budget: BUDGET, interpretation_clock: NOW };
  const query_id = compileConditionalFieldQuery(compile_input).query_id;
  const interpretation_id = interpretationIdentity({ interpretation_clock: NOW });
  const execution_receipt = { schema_version: 1 as const, workspace_id: "workspace", requested_budget: BUDGET,
    compile_input, query_id, interpretation_id, snapshot_id: SNAPSHOT, interpretation_clock: NOW };
  const index = InformationIndexSchema.parse({
    schema_version: 1, query_id, snapshot_id: SNAPSHOT, result_version: "v1",
    interpretation_id, as_of: NOW,
    entries: targets.map((target, offset) => ({
      schema_version: 1,
      ...(target.kind === "memory_entry" ? { object_id: target.object_id } : {}),
      target, hypothesis_id: `h${offset}`, output_binding: `binding${offset}`, role: "requested",
      association_milligrades: 850, claim: "unknown", explanation_ids: ["unresolved-explanation"],
      program_state: "matched", time_state: "current"
    })),
    completeness: { schema_version: 1, logical_index: "open", observed_coverage: "open",
      interpretation_coverage: "open", transport: "partial", payload: "complete", representation: "complete" },
    continuation: null,
    representation: { schema_version: 1, policy: "construct_index_then_page_then_payload",
      page_budget: 10, identity_tie_break: "serialization" }
  });
  const results: MemorySearchResult[] = index.entries.map((entry) => ({
    ...(entry.object_id === undefined ? {} : { object_id: entry.object_id }),
    object_kind: entry.target.kind === "source_evidence" ? "source_evidence" : "memory_entry",
    target: entry.target, relevance_score: 0.85, content_preview: "preview", evidence_pointers: [],
    selection_reason: "observed association", hypothesis_id: entry.hypothesis_id, output_binding: entry.output_binding,
    program_state: entry.program_state, time_state: entry.time_state,
    source_channels: ["conditional_field"], score_factors: { activation: 0.85, relevance: 0.85 },
    budget_state: { token_estimate: 1, max_entries: 10, max_total_tokens: 2000,
      remaining_entries: 0, remaining_tokens: 0, within_budget: true }
  }));
  const recallResult = { delivery_id: "delivery", protocol_version: 1, index, results,
    total_count: results.length, provider_calls: 0, garden_enqueue: 0, request_budget: BUDGET, execution_receipt };
  const deliveredResults = results.slice(0, 10).map((row, offset) => ({
    ...(row.object_id === undefined ? {} : { object_id: row.object_id }),
    target: row.target, object_kind: row.object_kind, rank: offset + 1, relevance_score: row.relevance_score,
    hypothesis_id: row.hypothesis_id, output_binding: row.output_binding,
    program_state: row.program_state, time_state: row.time_state
  }));
  return { recallResult, deliveredResults, queryText: "deployment checklist", workspaceId: "workspace",
    referenceTime: NOW, expectedIndexSnapshotId: SNAPSHOT, requestBudget: BUDGET, recallLatencyMs: 12 };
}

describe("source gold join and mixed-kind first-exposure", () => {
  it("joins record-only source gold and does not treat an extracted memory twin as the source key", () => {
    const recordOnly = measureConditionalFieldResponse({
      ...fixture([sourceTarget()]), goldSourceUnits: [SOURCE_GOLD], goldMemoryIds: ["rec-1"]
    });
    expect(recordOnly).toMatchObject({
      status: "validated",
      metrics: {
        mixed_kind_first_exposure: {
          contract: MIXED_KIND_FIRST_EXPOSURE_CONTRACT, denominator: SOURCE_GOLD_JOIN_DENOMINATOR,
          gold_unit_count: 1, joined_unit_count: 1,
          any_at_1: { status: "hit", value: true }, any_at_5: { status: "hit", value: true }
        },
        historical_memory_any_at_k: {
          contract: HISTORICAL_MEMORY_ANY_AT_K_CONTRACT, denominator: HISTORICAL_MEMORY_ANY_AT_K_DENOMINATOR,
          hit_at_1: { status: "miss", value: false }
        }
      }
    });
    const twin = measureConditionalFieldResponse({
      ...fixture([memoryTarget("rec-1")]), goldSourceUnits: [SOURCE_GOLD], goldMemoryIds: ["rec-1"]
    });
    expect(twin).toMatchObject({
      status: "validated",
      metrics: {
        mixed_kind_first_exposure: {
          any_at_1: { status: "miss", value: false }, any_at_10: { status: "miss", value: false },
          joined_unit_count: 0
        },
        historical_memory_any_at_k: { hit_at_1: { status: "hit", value: true } }
      }
    });
  });

  it("does not score mixed-kind any_at_1 as hit when QuestionDiagnosticInput omits goldSourceUnits", () => {
    const base = fixture([sourceTarget()]);
    const input: QuestionDiagnosticInput = {
      ...base,
      questionId: "q-source-gold-omitted",
      goldMemoryIds: ["rec-1"],
      answerSessionIds: ["session"],
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      degradationReason: null,
      embeddingMode: "disabled"
    };
    expect(Object.hasOwn(input, "goldSourceUnits")).toBe(false);
    const measured = measureConditionalFieldResponse(input);
    expect(measured).toMatchObject({
      status: "validated",
      metrics: {
        mixed_kind_first_exposure: { any_at_1: { status: "unavailable", value: null } }
      }
    });
    expect(measured && "metrics" in measured ? measured.metrics.mixed_kind_first_exposure.any_at_1.status : null)
      .not.toBe("hit");
    const diagnostic = buildQuestionDiagnostic(input);
    expect(diagnostic.conditional_field_measurement).toMatchObject({
      status: "validated",
      metrics: {
        mixed_kind_first_exposure: { any_at_1: { status: "unavailable", value: null } }
      }
    });
    const mixed = diagnostic.conditional_field_measurement;
    expect(mixed && mixed.status === "validated" ? mixed.metrics.mixed_kind_first_exposure.any_at_1 : null)
      .not.toEqual({ status: "hit", value: true });
  });

  it("marks mixed-kind Any@K unavailable when source gold is missing instead of scoring a miss", () => {
    const measured = measureConditionalFieldResponse(fixture([sourceTarget()]));
    expect(measured).toMatchObject({
      status: "validated",
      metrics: {
        mixed_kind_first_exposure: {
          contract: MIXED_KIND_FIRST_EXPOSURE_CONTRACT, denominator: SOURCE_GOLD_JOIN_DENOMINATOR,
          gold_unit_count: 0, joined_unit_count: 0,
          any_at_1: { status: "unavailable", value: null },
          any_at_5: { status: "unavailable", value: null },
          any_at_10: { status: "unavailable", value: null }
        }
      }
    });
    if (measured?.status !== "validated") throw new Error("validated measurement expected");
    expect(measured.metrics.mixed_kind_first_exposure.any_at_1.status).not.toBe("miss");
    expect(measured.metrics.relationship_correctness).toMatchObject({ status: "unavailable", value: null });
    expect(measured.metrics.interpretation_correctness).toMatchObject({ status: "unavailable", value: null });
  });

  it("freezes first-exposure slots and mixed-kind Any@K when a later page carries product_updates", () => {
    const first = fixture([sourceTarget({ root_id: "other-root" })]);
    const before = measureConditionalFieldResponse({ ...first, goldSourceUnits: [SOURCE_GOLD] });
    if (before?.status !== "validated") throw new Error("validated first page expected");
    const update = sourceProductStateKey({
      workspace_id: "workspace", root_kind: "source_record", root_id: "rec-1", source_version: "v1",
      content_digest: DIGEST, evidence_object_id: null, program_state: "matched",
      hypothesis_id: "h-update", binding_context: "binding0", time_state: "current"
    });
    const recallResult = {
      ...first.recallResult,
      index: { ...first.recallResult.index, page_purpose: "update" as const, product_updates: [{
        schema_version: 1 as const, product: update, update_kind: "proof" as const, revision: "rev-2"
      }] }
    };
    const after = measureConditionalFieldResponse({ ...first, recallResult, goldSourceUnits: [SOURCE_GOLD] });
    if (after?.status !== "validated") throw new Error("validated update page expected");
    expect(after.first_exposure_slots).toEqual(before.first_exposure_slots);
    expect(after.metrics.mixed_kind_first_exposure).toEqual(before.metrics.mixed_kind_first_exposure);
    expect(after.metrics.mixed_kind_first_exposure.any_at_1).toEqual({ status: "miss", value: false });
    expect(after.product_updates).toHaveLength(1);
    expect(after.evaluated_slots[0]?.target).toMatchObject({ root_id: "other-root" });
  });

  it("rejects truncated and foreign-target archives before scoring", () => {
    const input = fixture([memoryTarget("gold"), memoryTarget("other")]);
    const truncated = {
      ...input.recallResult,
      total_count: 2,
      results: input.recallResult.results.slice(0, 1),
      index: { ...input.recallResult.index, entries: input.recallResult.index.entries.slice(0, 1) }
    };
    expect(measureConditionalFieldResponse({
      ...input, recallResult: truncated, deliveredResults: input.deliveredResults.slice(0, 1),
      goldSourceUnits: [SOURCE_GOLD]
    })).toMatchObject({ status: "invalid", reason: "truncated_archive" });
    const single = fixture([memoryTarget("gold")]);
    const foreign = {
      ...single.recallResult,
      results: single.recallResult.results.map((result) => ({
        ...result, target: { ...result.target as Extract<RecallTargetRef, { kind: "memory_entry" }>,
          source_revision: "foreign-revision" }
      }))
    };
    expect(measureConditionalFieldResponse({ ...single, recallResult: foreign, goldSourceUnits: [SOURCE_GOLD] }))
      .toMatchObject({ status: "invalid", reason: "foreign_target_revision" });
    expect(measureConditionalFieldResponse({
      ...input,
      recallResult: { ...input.recallResult, results: input.recallResult.results.slice(0, 1) },
      deliveredResults: input.deliveredResults.slice(0, 1)
    })).toMatchObject({ status: "invalid", reason: "omitted_prefix_page" });
  });

  it("keeps historical gold_memory_ids Any@K on memory-only fixtures without renaming it", () => {
    const measured = measureConditionalFieldResponse({
      ...fixture([memoryTarget("gold")]), goldMemoryIds: ["gold"]
    });
    expect(measured).toMatchObject({
      status: "validated",
      gold_memory_ids: ["gold"],
      metrics: {
        historical_memory_any_at_k: {
          contract: HISTORICAL_MEMORY_ANY_AT_K_CONTRACT, denominator: HISTORICAL_MEMORY_ANY_AT_K_DENOMINATOR,
          gold_memory_id_count: 1,
          hit_at_1: { status: "hit", value: true },
          hit_at_5: { status: "hit", value: true },
          hit_at_10: { status: "hit", value: true }
        },
        mixed_kind_first_exposure: { any_at_1: { status: "unavailable", value: null } }
      }
    });
    const mixedPage = measureConditionalFieldResponse({
      ...fixture([sourceTarget(), memoryTarget("gold")]), goldMemoryIds: ["gold"]
    });
    expect(mixedPage).toMatchObject({
      status: "validated",
      metrics: {
        historical_memory_any_at_k: {
          hit_at_1: { status: "miss", value: false }, hit_at_5: { status: "hit", value: true }
        }
      }
    });
  });
});
