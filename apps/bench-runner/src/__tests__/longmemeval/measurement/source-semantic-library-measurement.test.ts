import { afterEach, describe, expect, it, vi } from "vitest";
import { SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET, SourceSemanticWorkerResultSchema } from "@do-soul/alaya-protocol";
import { encodeSourceSemanticLibraryResponse, encodeSourceSemanticLibraryResults } from "@do-soul/alaya-core";
import * as core from "@do-soul/alaya-core";
import { REQUEST, GOLD, GOLD_TARGET, sourceOnly, proofEntry, assemble, workerRecall, nativeProofResponseFixture } from "./source-semantic-library-measurement-fixture.js";
import { measureConditionalFieldResponse } from "../../../runs/measurement/conditional-field-measurement.js";
import { recordSourceSemanticLibraryFirstExposure } from "../../../runs/measurement/source-semantic-library-recall.js";
import {
  measureSourceSemanticLibraryResponse, readmitSourceSemanticLibraryMeasurement, readmitHistoricalSourceOnlyLibraryMeasurement
} from "../../../runs/measurement/source-semantic-library-measurement.js";
import {
  PROOF_CONDITIONED_FIRST_EXPOSURE_CONTRACT,
  scoreMixedKindFirstExposure, scoreProofConditionedFirstExposure
} from "../../../runs/measurement/source-gold-join.js";

function measureOf(result: ReturnType<typeof workerRecall>) {
  return measureSourceSemanticLibraryResponse({
    recallResult: result,
    firstExposurePage: recordSourceSemanticLibraryFirstExposure(result),
    requestBudget: REQUEST,
    goldSourceUnits: [GOLD]
  });
}
afterEach(() => vi.restoreAllMocks());

describe("source semantic library measurement", () => {
  it.each(["unknown_result_version", "old_result_version", "absent_protocol_version"])("rejects %s before source-only scoring", (mutation) => {
    const response = structuredClone(encodeSourceSemanticLibraryResponse(workerRecall(assemble([sourceOnly("gold")], []))));
    if (response.operation !== "recall" || response.index === undefined) throw new Error("native delivery expected");
    if (mutation === "absent_protocol_version") Reflect.deleteProperty(response, "protocol_version");
    else Object.assign(response.index, { result_version: mutation === "old_result_version" ? "source-semantic-library-v1" : "not-a-native-library-result" });
    expect(measureSourceSemanticLibraryResponse({ recallResult: response,
      firstExposurePage: recordSourceSemanticLibraryFirstExposure(response), requestBudget: REQUEST, goldSourceUnits: [GOLD] }))
      .toMatchObject({ measurement: { status: "invalid", reason: "invalid_response" }, sourceBearingUnion: null,
        evaluator_usage: { proof_slots_checked: 0, work_units: 0, logical_memory_bytes: 0 } });
  });

  it("keeps legitimate outcome-only recall unavailable and rejects partial delivery", () => {
    const response = encodeSourceSemanticLibraryResponse(workerRecall(assemble([sourceOnly("gold")], [])));
    if (response.operation !== "recall") throw new Error("native delivery expected");
    const outcome = { operation: "recall", outcome: { status: "preparation_required", missing: "query_semantics" },
      coverage: response.coverage, work: response.work, provider_attempts: 0 };
    const input = { recallResult: outcome, firstExposurePage: recordSourceSemanticLibraryFirstExposure(response),
      requestBudget: REQUEST, goldSourceUnits: [GOLD] };
    expect(measureSourceSemanticLibraryResponse(input)).toMatchObject({ measurement: null, sourceBearingUnion: null });
    expect(measureSourceSemanticLibraryResponse({ ...input, recallResult: { ...outcome, results: [] } }))
      .toMatchObject({ measurement: { status: "invalid" }, sourceBearingUnion: null });
  });

  it("admits the historical canonical ten-slot tuple beyond five entries without changing its recorded bytes", () => {
    const response = structuredClone(encodeSourceSemanticLibraryResponse(workerRecall(assemble([sourceOnly("gold")], []))));
    if (response.operation !== "recall") throw new Error("native delivery expected");
    const input = { recallResult: response, firstExposurePage: recordSourceSemanticLibraryFirstExposure(response), requestBudget: REQUEST, goldSourceUnits: [GOLD] };
    const evaluated = measureSourceSemanticLibraryResponse(input);
    if (response.operation !== "recall" || response.index === undefined || response.order === undefined
      || evaluated.measurement?.status !== "validated") throw new Error("native delivery expected");
    const stored = structuredClone(evaluated.measurement);
    Object.assign(response, { protocol_version: 1 });
    Reflect.deleteProperty(response, "request_identity");
    Object.assign(response.index, { result_version: "source-semantic-library-v1",
      continuation: { schema_version: 1, continuation_id: "historical-continuation", query_id: response.index.query_id,
        snapshot_id: response.index.snapshot_id, result_version: "source-semantic-library-v1", expires_at: "2026-09-19T00:00:00.000Z",
        cursor: "6", interpretation_id: response.index.interpretation_id, interpretation_clock: response.index.as_of,
        enumeration_policy: "canonical", result_kind_view: "mixed" },
      entries: [sourceOnly("gold"), ...Array.from({ length: 5 }, (_, index) => sourceOnly(`historical-${index}`))] });
    Object.assign(response.index.representation, { page_budget: 10 });
    Object.assign(response, { results: encodeSourceSemanticLibraryResults(response.index), total_count: 6,
      slot_qualifiers: response.index.entries.map((_, index) => ({ index, evidence_kind: "source_evidence" })) });
    Object.assign(response.order, { enumeration_policy: "canonical", page_budget: 10 });
    input.firstExposurePage = recordSourceSemanticLibraryFirstExposure(response);
    Object.assign(stored, { effective_page_budget: 10, delivered_index: response.index,
      first_exposure_page: input.firstExposurePage, first_exposure_slots: input.firstExposurePage.initial!.slots,
      slot_qualifiers: response.slot_qualifiers, metrics: {
        mixed_kind_first_exposure: scoreMixedKindFirstExposure(input.firstExposurePage.initial!.slots, [GOLD]),
        proof_conditioned_first_exposure: scoreProofConditionedFirstExposure(input.firstExposurePage.initial!.slots, [GOLD], new Set())
      } });
    Object.assign(stored.identity, { result_version: "source-semantic-library-v1" });
    const before = JSON.stringify({ response, stored });
    expect(readmitSourceSemanticLibraryMeasurement(stored, input).measurement?.status).toBe("invalid");
    const historical = readmitHistoricalSourceOnlyLibraryMeasurement(stored, input);
    expect(historical.measurement).toEqual(stored);
    expect(historical.sourceBearingUnion?.any_at_5.status).toBe("hit");
    expect(JSON.stringify({ response, stored })).toBe(before);
    Object.assign(response.index, { result_version: "unknown" });
    expect(readmitHistoricalSourceOnlyLibraryMeasurement(stored, input).measurement?.status).toBe("invalid");
  });

  it.each([false, true])("verifies each actual proof slot once and retains a later valid hit (unverified first=%s)", (unverifiedFirst) => {
    const { response, record, gold } = nativeProofResponseFixture(unverifiedFirst);
    const verify = vi.spyOn(core, "deliveredSourceSemanticLibraryProof");
    const input = { recallResult: response, firstExposurePage: recordSourceSemanticLibraryFirstExposure(response),
      requestBudget: REQUEST, goldSourceUnits: [gold], sourceRecords: [record] };
    const evaluated = measureSourceSemanticLibraryResponse(input);
    expect(verify).toHaveBeenCalledTimes(unverifiedFirst ? 2 : 1);
    expect(evaluated.sourceBearingUnion?.any_at_5.status).toBe("hit");
    expect(evaluated.validatedProofRanks).toEqual([unverifiedFirst ? 2 : 1]);
    expect(evaluated.measurement).toMatchObject({ status: "validated", metrics: {
      proof_conditioned_first_exposure: { any_at_5: { status: unverifiedFirst ? "unavailable" : "hit" } }
    } });
    expect(evaluated.evaluator_usage.proof_slots_checked).toBe(unverifiedFirst ? 2 : 1);
    expect(evaluated.evaluator_usage.work_units).toBeGreaterThan(0);
    expect(evaluated.evaluator_usage.logical_memory_bytes).toBeGreaterThan(0);
    const freshWork = verify.mock.results.reduce((sum, result) => sum + (result.type === "return" ? result.value.resource_usage.work_units : 0), 0);
    expect(evaluated.evaluator_usage.work_units).toBe(freshWork);
    verify.mockClear();
    expect(readmitSourceSemanticLibraryMeasurement(evaluated.measurement, input)).toEqual(evaluated);
    expect(verify).toHaveBeenCalledTimes(unverifiedFirst ? 2 : 1);
  });

  it("freshly rejects a forged stored answer without trusting its previous validated measurement", () => {
    const { response, record, gold } = nativeProofResponseFixture();
    const input = { recallResult: response, firstExposurePage: recordSourceSemanticLibraryFirstExposure(response),
      requestBudget: REQUEST, goldSourceUnits: [gold], sourceRecords: [record] };
    const original = measureSourceSemanticLibraryResponse(input);
    if (original.measurement?.status !== "validated") throw new Error("native proof measurement expected");
    const changed = structuredClone(response), stored = structuredClone(original.measurement);
    const answer = changed.proofs![0]!.binding_results![0]!;
    Object.assign(answer.bindings.tools!, { node_id: "rY" });
    Object.assign(answer.returned.tools!, { node_id: "rY" });
    Object.assign(stored, { delivered_proofs: changed.proofs });
    const verify = vi.spyOn(core, "deliveredSourceSemanticLibraryProof");
    const evaluated = readmitSourceSemanticLibraryMeasurement(stored, { ...input, recallResult: changed });
    expect(evaluated.measurement?.status).toBe("invalid");
    expect(evaluated.sourceBearingUnion).toBeNull();
    expect(verify).toHaveBeenCalledTimes(1);
    expect(evaluated.evaluator_usage.work_units).toBeGreaterThan(0);
  });

  it("records spent evaluator work when a native proof cannot be verified within the request budget", () => {
    const { response, record, gold } = nativeProofResponseFixture();
    const budget = { ...REQUEST, work_units: 100 };
    const bounded = { ...response, request_budget: budget };
    const verify = vi.spyOn(core, "deliveredSourceSemanticLibraryProof");
    const evaluated = measureSourceSemanticLibraryResponse({ recallResult: bounded,
      firstExposurePage: recordSourceSemanticLibraryFirstExposure(bounded), requestBudget: budget,
      goldSourceUnits: [gold], sourceRecords: [record] });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(evaluated.measurement?.status).toBe("validated");
    expect(evaluated.sourceBearingUnion?.any_at_5.status).toBe("unavailable");
    expect(evaluated.evaluator_usage.work_units).toBeGreaterThan(0);
    expect(evaluated.evaluator_usage.work_units).toBeLessThanOrEqual(budget.work_units);
    expect(evaluated.evaluator_usage.logical_memory_bytes).toBeGreaterThan(0);
  });

  it("does not reuse admission across budget, exposure, provider or publication changes", () => {
    const { response, record, gold } = nativeProofResponseFixture();
    const input = { recallResult: response, firstExposurePage: recordSourceSemanticLibraryFirstExposure(response),
      requestBudget: REQUEST, goldSourceUnits: [gold], sourceRecords: [record] };
    const original = measureSourceSemanticLibraryResponse(input);
    const verify = vi.spyOn(core, "deliveredSourceSemanticLibraryProof");
    const changed = structuredClone(response);
    Object.assign(changed.results![0]!, { output_binding: "different" });
    for (const rejected of [ { ...input, requestBudget: { ...REQUEST, work_units: 1 } },
      { ...input, recallResult: { ...response, provider_attempts: 1 } }, { ...input, sourceRecords: [] },
      { ...input, recallResult: changed, firstExposurePage: recordSourceSemanticLibraryFirstExposure(changed) } ]) {
      expect(readmitSourceSemanticLibraryMeasurement(original.measurement, rejected).measurement?.status).toBe("invalid");
    }
    expect(verify).not.toHaveBeenCalled();
    expect(readmitSourceSemanticLibraryMeasurement(original.measurement, input).sourceBearingUnion?.any_at_5.status).toBe("hit");
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it.each(["target", "hypothesis_id", "output_binding", "program_state", "time_state", "object_kind", "relevance_score",
    "missing", "extra", "reordered", "duplicate", "total_count", "qualifier", "missing_results", "missing_total_count"] as const)(
    "rejects delivered %s inconsistency before scoring source or proof slots", (kind) => {
      const response = structuredClone(encodeSourceSemanticLibraryResponse(workerRecall(assemble([sourceOnly("other-one"), sourceOnly("other-two")], []))));
      if (response.operation !== "recall" || response.results === undefined || response.index === undefined || response.slot_qualifiers === undefined) {
        throw new Error("native public recall expected");
      }
      const result = response.results[0]!;
      if (kind === "target") Object.assign(result, { target: GOLD_TARGET });
      else if (kind === "object_kind") Object.assign(result, { object_kind: "semantic_proof" });
      else if (kind === "relevance_score") Object.assign(result, { relevance_score: 1 });
      else if (kind === "missing") Object.assign(response, { results: response.results.slice(1), total_count: 1 });
      else if (kind === "extra") Object.assign(response, { results: [...response.results, result], total_count: 3 });
      else if (kind === "reordered") Object.assign(response, { results: [...response.results].reverse() });
      else if (kind === "duplicate") Object.assign(response, { results: [result, result] });
      else if (kind === "total_count") Object.assign(response, { total_count: 0 });
      else if (kind === "missing_results") Reflect.deleteProperty(response, "results");
      else if (kind === "missing_total_count") Reflect.deleteProperty(response, "total_count");
      else if (kind === "qualifier") Object.assign(response, { slot_qualifiers: [response.slot_qualifiers[0], response.slot_qualifiers[0]] });
      else Object.assign(result, { [kind]: "forged-coordinate" });
      const firstExposurePage = recordSourceSemanticLibraryFirstExposure(response);
      expect(measureSourceSemanticLibraryResponse({ recallResult: response, firstExposurePage, requestBudget: REQUEST, goldSourceUnits: [GOLD] }))
        .toMatchObject({ measurement: { status: "invalid" }, sourceBearingUnion: null,
          evaluator_usage: { proof_slots_checked: 0, work_units: 0, logical_memory_bytes: 0 } });
    });

  it("rejects a self-consistent stored exposure and metric for a root absent from the native index", () => {
    const response = encodeSourceSemanticLibraryResponse(workerRecall(assemble([sourceOnly("other")], [proofEntry("unverified")])));
    if (response.operation !== "recall" || response.results === undefined) throw new Error("native public recall expected");
    const measured = measureSourceSemanticLibraryResponse({ recallResult: response,
      firstExposurePage: recordSourceSemanticLibraryFirstExposure(response), requestBudget: REQUEST, goldSourceUnits: [GOLD] }).measurement;
    if (measured?.status !== "validated") throw new Error("native source measurement expected");
    expect(measured.metrics.mixed_kind_first_exposure.any_at_5.status).toBe("miss");
    expect(measured.metrics.proof_conditioned_first_exposure.any_at_5.status).toBe("unavailable");
    const forged = structuredClone(response);
    Object.assign(forged.results!.find((result) => result.object_kind === "source_evidence")!, { target: GOLD_TARGET });
    const first_exposure_page = recordSourceSemanticLibraryFirstExposure(forged);
    const slots = first_exposure_page.initial!.slots;
    const changed = { ...measured, first_exposure_page, first_exposure_slots: slots,
      metrics: { ...measured.metrics, mixed_kind_first_exposure: scoreMixedKindFirstExposure(slots, [GOLD]) } };
    expect(changed.metrics.mixed_kind_first_exposure.any_at_5.status).toBe("hit");
    expect(readmitSourceSemanticLibraryMeasurement(changed, { recallResult: forged, firstExposurePage: first_exposure_page,
      requestBudget: REQUEST, goldSourceUnits: [GOLD] }).measurement?.status).toBe("invalid");
  });

  it("does not join a semantic_proof slot as mixed source retrieval", () => {
    const proofSlot = { rank: 1, object_kind: "semantic_proof" as const, target: GOLD_TARGET };
    const sourceSlot = { rank: 1, object_kind: "source_evidence" as const, target: GOLD_TARGET };
    expect(scoreMixedKindFirstExposure([proofSlot], [GOLD]).any_at_5)
      .toEqual({ status: "miss", value: false });
    expect(scoreProofConditionedFirstExposure([proofSlot], [GOLD], new Set([1])).any_at_5)
      .toEqual({ status: "hit", value: true });
    expect(scoreMixedKindFirstExposure([sourceSlot], [GOLD]).any_at_5)
      .toEqual({ status: "hit", value: true });
    expect(scoreProofConditionedFirstExposure([sourceSlot], [GOLD], new Set()).any_at_5)
      .toEqual({ status: "miss", value: false });
  });

  it("retains a native source hit when a different delivered proof remains unverified", () => {
    const evaluated = measureOf(workerRecall(assemble([sourceOnly("gold")], [proofEntry("other")])));
    const measured = evaluated.measurement;
    expect(measured).toMatchObject({ status: "validated", metrics: {
      mixed_kind_first_exposure: { any_at_5: { status: "hit" } },
      proof_conditioned_first_exposure: { any_at_5: { status: "unavailable" } }
    } });
    if (measured?.status !== "validated") throw new Error("consistent native page expected");
    expect(evaluated.validatedProofRanks).toEqual([]);
    expect(evaluated.sourceBearingUnion?.any_at_5.status).toBe("hit");
    expect(evaluated.evaluator_usage.proof_slots_checked).toBe(1);
  });

  it("scores mixed source retrieval but rejects label-only proof claims", () => {
    const evaluated = measureOf(workerRecall(assemble([sourceOnly("gold")], [proofEntry("gold")])));
    const withProof = evaluated.measurement;
    const withoutProof = measureOf(workerRecall(assemble([sourceOnly("gold")], []))).measurement;
    expect(withProof).toMatchObject({
      status: "validated", provider_calls: 0,
      request: { budget: { page_budget: REQUEST.page_budget } },
      metrics: {
        mixed_kind_first_exposure: { any_at_10: { status: "miss", value: false } },
        proof_conditioned_first_exposure: {
          contract: PROOF_CONDITIONED_FIRST_EXPOSURE_CONTRACT,
          any_at_10: { status: "unavailable", value: null }
        }
      }
    });
    expect(withoutProof).toMatchObject({
      status: "validated", provider_calls: 0,
      request: { budget: { page_budget: REQUEST.page_budget } },
      metrics: {
        mixed_kind_first_exposure: { any_at_10: { status: "hit", value: true } },
        proof_conditioned_first_exposure: { any_at_10: { status: "miss", value: false } }
      }
    });
    expect(withProof && "request" in withProof ? "execution_receipt" in withProof.request : true).toBe(false);
    if (withProof?.status !== "validated") throw new Error("native measurement must retain unavailable proof status");
    expect(evaluated.validatedProofRanks).toEqual([]);
    expect(evaluated.sourceBearingUnion?.any_at_5.status).toBe("unavailable");
    expect(REQUEST.page_budget).not.toBe(SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET);
    expect(withoutProof && "metrics" in withoutProof
      ? withoutProof.metrics.mixed_kind_first_exposure.any_at_10
      : null).not.toEqual(withoutProof && "metrics" in withoutProof
      ? withoutProof.metrics.proof_conditioned_first_exposure.any_at_10
      : undefined);
    const recalled = workerRecall(assemble([sourceOnly("gold")], [proofEntry("gold")]));
    expect(measureConditionalFieldResponse({ recallResult: recalled, deliveredResults: [] })?.status)
      .not.toBe("validated");
  });

  it("rejects a non-library index page budget at the shared delivery boundary", () => {
    const recalled = workerRecall(assemble([sourceOnly("gold")], []));
    const disagreed = {
      ...recalled,
      index: {
        ...recalled.index,
        representation: { ...recalled.index.representation, page_budget: REQUEST.page_budget }
      }
    };
    expect(SourceSemanticWorkerResultSchema.safeParse(disagreed).success).toBe(false);
    expect(measureSourceSemanticLibraryResponse({
      recallResult: disagreed,
      firstExposurePage: recordSourceSemanticLibraryFirstExposure(recalled),
      requestBudget: REQUEST,
      goldSourceUnits: [GOLD]
    }).measurement).toEqual({ schema_version: 1, status: "invalid", reason: "invalid_response" });
  });
});
