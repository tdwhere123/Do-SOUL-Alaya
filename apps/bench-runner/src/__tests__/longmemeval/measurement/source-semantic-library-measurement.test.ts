import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterAll(() => { isolation.restore(); expect(isolation.violations).toEqual([]); });
import { SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET, SourceSemanticWorkerResultSchema, sourceSemanticExecution,
  sourceSemanticExecutionPhases, SourceSemanticExecutionSchema } from "@do-soul/alaya-protocol";
import { encodeSourceSemanticLibraryResponse, encodeSourceSemanticLibraryResults } from "@do-soul/alaya-core";
import * as core from "@do-soul/alaya-core";
import { DIGEST, REQUEST, GOLD, GOLD_TARGET, sourceOnly, assemble, workerRecall, nativeProofResponseFixture,
  nativeSourceHitWithUnverifiedProofFixture, libraryAccessPhases } from "./source-semantic-library-measurement-fixture.js";
import { measureConditionalFieldResponse } from "../../../runs/measurement/conditional-field-measurement.js";
import { recordSourceSemanticLibraryFirstExposure } from "../../../runs/measurement/source-semantic-library-recall.js";
import {
  admitSourceSemanticLibraryResponse, measureSourceSemanticLibraryResponse,
  readmitSourceSemanticLibraryMeasurement, readmitHistoricalSourceOnlyLibraryMeasurement
} from "../../../runs/measurement/source-semantic-library-measurement.js";
import {
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
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("source semantic library measurement", () => {
  it("admits a new reader exposure without spending a proof verification allowance", () => {
    const { response } = nativeProofResponseFixture();
    const verify = vi.spyOn(core, "deliveredSourceSemanticLibraryProof");
    const input = { recallResult: response, firstExposurePage: recordSourceSemanticLibraryFirstExposure(response), requestBudget: REQUEST };
    expect(admitSourceSemanticLibraryResponse(input)).toMatchObject({ status: "admitted", index: response.index,
      proofs: response.proofs, exposure: input.firstExposurePage });
    expect(admitSourceSemanticLibraryResponse({ ...input, requestBudget: { ...REQUEST, work_units: 1 } }))
      .toMatchObject({ status: "invalid", reason: "request_budget_mismatch" });
    expect(admitSourceSemanticLibraryResponse({ ...input, firstExposurePage: { ...input.firstExposurePage,
      commitment: "0".repeat(64) } })).toMatchObject({ status: "invalid", reason: "missing_first_exposure" });
    expect(verify).not.toHaveBeenCalled();
  });

  it.each(["source", "interpretation", "computation"] as const)("keeps an unvisited or unfinished %s negative unavailable in worker and public measurement", kind => {
    const result = workerRecall(assemble([sourceOnly("other")], []));
    const discovery = { ...result.discovery, ...(kind === "computation" ? { open_residuals: true } : { access: {
      contract: "source-semantic-access-v2" as const, ...libraryAccessPhases, policy: "canonical-v1" as const,
      input_id: GOLD.content_digest, pool_id: GOLD.content_digest,
      observed_source_count: 1, observed_interpretation_count: 0, source_candidates: [], interpretation_candidates: [],
      trace: { kind: "library_selection" as const, omitted_source_count: 1, omitted_interpretation_count: 0 },
      unvisited_sources: kind === "source", unvisited_interpretations: kind === "interpretation", stopping_reasons: ["budget" as const]
    } }) };
    const worker = { ...result, discovery };
    for (const recallResult of [worker, encodeSourceSemanticLibraryResponse(worker)]) {
      if (!("index" in recallResult)) throw new Error("native delivery expected");
      const input = { recallResult, firstExposurePage: recordSourceSemanticLibraryFirstExposure(recallResult),
        requestBudget: REQUEST, goldSourceUnits: [GOLD] };
      const evaluated = measureSourceSemanticLibraryResponse(input);
      expect(evaluated.sourceBearingUnion?.any_at_5).toMatchObject({ status: "unavailable", value: null,
        reason: "native access or computation remains unresolved" });
      expect(evaluated.measurement).toMatchObject({ status: "validated", native_observation: { discovery },
        metrics: { delivered_slot_union: { any_at_5: { status: "miss" } },
          mixed_kind_first_exposure: { any_at_5: { status: "miss" } } } });
      expect(readmitSourceSemanticLibraryMeasurement(evaluated.measurement, input)).toEqual(evaluated);
      const changed = structuredClone(evaluated.measurement);
      if (changed?.status !== "validated" || !("native_observation" in changed)) throw new Error("current native observation expected");
      Object.assign(changed.native_observation.discovery, { open_residuals: !discovery.open_residuals });
      expect(readmitSourceSemanticLibraryMeasurement(changed, input).measurement?.status).toBe("invalid");
      const changedStatus = structuredClone(evaluated.measurement);
      if (changedStatus?.status !== "validated" || !("native_observation" in changedStatus)) throw new Error("current native observation expected");
      Object.assign(changedStatus.native_observation, { query_semantics_status: { status: "unavailable", reason: "absent" } });
      expect(readmitSourceSemanticLibraryMeasurement(changedStatus, input).measurement?.status).toBe("invalid");
    }
  });

  it("rejects a historic access v1 receipt instead of scoring it as a current observation", () => {
    const result = workerRecall(assemble([sourceOnly("other")], []));
    const count = result.index.entries.length;
    const historicAccess = {
      contract: "source-semantic-access-v1", policy: "canonical-v1",
      input_id: DIGEST, pool_id: DIGEST, observed_source_count: count, observed_interpretation_count: 0,
      source_candidates: [], interpretation_candidates: [],
      trace: { kind: "library_selection", omitted_source_count: count, omitted_interpretation_count: 0 },
      unvisited_sources: true, unvisited_interpretations: false, stopping_reasons: ["budget"]
    };
    const worker = { ...result, discovery: { ...result.discovery, access: historicAccess as never } };
    const fetch = vi.fn(() => { throw new Error("provider transport forbidden"); });
    vi.stubGlobal("fetch", fetch);
    expect(SourceSemanticWorkerResultSchema.safeParse(worker).success).toBe(false);
    expect(measureSourceSemanticLibraryResponse({
      recallResult: worker, firstExposurePage: recordSourceSemanticLibraryFirstExposure(result),
      requestBudget: REQUEST, goldSourceUnits: [GOLD]
    })).toMatchObject({ measurement: { status: "invalid", reason: "invalid_response" }, sourceBearingUnion: null });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves observed source and validated proof hits while unrelated native access remains open", () => {
    const sourceResponse = encodeSourceSemanticLibraryResponse(workerRecall(assemble([sourceOnly("gold")], [])));
    const proof = nativeProofResponseFixture();
    for (const [response, gold, sourceRecords] of [[sourceResponse, GOLD, []], [proof.response, proof.gold, [proof.record]]] as const) {
      if (response.operation !== "recall" || response.discovery === undefined) throw new Error("native response expected");
      const recallResult = { ...response, discovery: { ...response.discovery, open_residuals: true, truncated: true } };
      const evaluated = measureSourceSemanticLibraryResponse({ recallResult,
        firstExposurePage: recordSourceSemanticLibraryFirstExposure(recallResult), requestBudget: REQUEST,
        goldSourceUnits: [gold], sourceRecords });
      expect(evaluated.sourceBearingUnion?.any_at_5.status).toBe("hit");
    }
  });

  it("retains a complete-pool miss when only frozen later pages remain", () => {
    const index = assemble(Array.from({ length: 6 }, (_, offset) => sourceOnly(`other-${offset}`)), []);
    expect(index.continuation).not.toBeNull();
    expect(index.completeness.logical_index).toBe("partial");
    const evaluated = measureOf(workerRecall(index));
    expect(evaluated.sourceBearingUnion?.any_at_5).toEqual({ status: "miss", value: false });
  });

  it.each([
    { name: "access is absent", mutate: (result: ReturnType<typeof workerRecall>) => {
      const { access: _access, ...discovery } = result.discovery;
      return { ...result, discovery };
    } },
    { name: "conditional computation is open", mutate: (result: ReturnType<typeof workerRecall>) => ({
      ...result, coverage: { ...result.coverage, conditional_computation: "open" as const }
    }) },
    { name: "conditional computation is truncated", mutate: (result: ReturnType<typeof workerRecall>) => ({
      ...result, coverage: { ...result.coverage, conditional_computation: "truncated" as const }
    }) }
  ])("keeps a negative unavailable when $name", ({ mutate }) => {
    const evaluated = measureOf(mutate(workerRecall(assemble([sourceOnly("other")], []))));
    expect(evaluated.sourceBearingUnion?.any_at_5).toMatchObject({ status: "unavailable", value: null,
      reason: "native access or computation remains unresolved" });
    expect(evaluated.measurement).toMatchObject({ status: "validated",
      metrics: { delivered_slot_union: { any_at_5: { status: "miss" } } } });
  });

  it.each([
    { name: "access is absent", mutate: (result: ReturnType<typeof workerRecall>) => {
      const { access: _access, ...discovery } = result.discovery;
      return { ...result, discovery };
    } },
    { name: "conditional computation is open", mutate: (result: ReturnType<typeof workerRecall>) => ({
      ...result, coverage: { ...result.coverage, conditional_computation: "open" as const }
    }) }
  ])("preserves an observed hit when $name", ({ mutate }) => {
    expect(measureOf(mutate(workerRecall(assemble([sourceOnly("gold")], [])))).sourceBearingUnion?.any_at_5.status)
      .toBe("hit");
  });

  it("retains a miss when unavailable-query source-only computation is unexercised and access is closed", () => {
    const result = workerRecall(assemble([sourceOnly("other")], []));
    const evaluated = measureOf({
      ...result, query_semantics_status: { status: "unavailable", reason: "absent" },
      coverage: { ...result.coverage, query_semantics: "unexercised", semantic_correspondence: "unexercised",
        conditional_computation: "unexercised" }
    });
    expect(evaluated.sourceBearingUnion?.any_at_5).toEqual({ status: "miss", value: false });
  });

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
      coverage: response.coverage, work: response.work, execution: sourceSemanticExecution() };
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
    Object.assign(stored, { contract: "source-semantic-library-delivered-slots-v1" });
    Reflect.deleteProperty(stored, "native_observation");
    Reflect.deleteProperty(stored.metrics, "delivered_slot_union");
    Object.assign(response, { protocol_version: 1 });
    Reflect.deleteProperty(response, "request_identity");
    Reflect.deleteProperty(response, "query_semantics_status");
    expect("query_semantics_status" in response).toBe(false);
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
    const phases = sourceSemanticExecutionPhases(response.execution);
    const unknownAttempts = sourceSemanticExecution(
      { ...phases.query_preparation, external_api_attempts: null }, phases.acquisition);
    const nonzeroAttempts = sourceSemanticExecution(
      { ...phases.query_preparation, external_api_attempts: 1 }, phases.acquisition);
    expect(SourceSemanticExecutionSchema.safeParse(unknownAttempts).success).toBe(true);
    expect(SourceSemanticExecutionSchema.safeParse(nonzeroAttempts).success).toBe(true);
    expect(sourceSemanticExecutionPhases(unknownAttempts).query_preparation.external_api_attempts).toBeNull();
    expect(sourceSemanticExecutionPhases(nonzeroAttempts).query_preparation.external_api_attempts).toBe(1);
    for (const rejected of [ { ...input, requestBudget: { ...REQUEST, work_units: 1 } },
      { ...input, recallResult: { ...response, execution: nonzeroAttempts } },
      { ...input, recallResult: { ...response, execution: unknownAttempts } },
      { ...input, sourceRecords: [] },
      { ...input, recallResult: changed, firstExposurePage: recordSourceSemanticLibraryFirstExposure(changed) } ]) {
      expect(readmitSourceSemanticLibraryMeasurement(original.measurement, rejected).measurement?.status).toBe("invalid");
    }
    expect(measureSourceSemanticLibraryResponse({ ...input, recallResult: { ...response, execution: unknownAttempts } }))
      .toMatchObject({ measurement: { status: "invalid", reason: "missing_zero_call_evidence" } });
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
      if (kind === "object_kind") {
        expect(() => recordSourceSemanticLibraryFirstExposure(response)).toThrow();
        return;
      }
      const firstExposurePage = recordSourceSemanticLibraryFirstExposure(response);
      expect(admitSourceSemanticLibraryResponse({ recallResult: response, firstExposurePage, requestBudget: REQUEST }))
        .toMatchObject({ status: "invalid" });
      expect(measureSourceSemanticLibraryResponse({ recallResult: response, firstExposurePage, requestBudget: REQUEST, goldSourceUnits: [GOLD] }))
        .toMatchObject({ measurement: { status: "invalid" }, sourceBearingUnion: null,
          evaluator_usage: { proof_slots_checked: 0, work_units: 0, logical_memory_bytes: 0 } });
    });

  it("rejects a self-consistent stored exposure and metric for a root absent from the native index", () => {
    const response = encodeSourceSemanticLibraryResponse(workerRecall(assemble([sourceOnly("other")], [])));
    if (response.operation !== "recall" || response.results === undefined) throw new Error("native public recall expected");
    const measured = measureSourceSemanticLibraryResponse({ recallResult: response,
      firstExposurePage: recordSourceSemanticLibraryFirstExposure(response), requestBudget: REQUEST, goldSourceUnits: [GOLD] }).measurement;
    if (measured?.status !== "validated") throw new Error("native source measurement expected");
    expect(measured.metrics.mixed_kind_first_exposure.any_at_5.status).toBe("miss");
    expect(measured.metrics.proof_conditioned_first_exposure.any_at_5.status).toBe("miss");
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
    const evaluated = measureOf(nativeSourceHitWithUnverifiedProofFixture());
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
    const withoutProof = measureOf(workerRecall(assemble([sourceOnly("gold")], [])));
    expect(withoutProof.measurement).toMatchObject({
      status: "validated", provider_calls: 0,
      request: { budget: { page_budget: REQUEST.page_budget } },
      metrics: {
        mixed_kind_first_exposure: { any_at_10: { status: "hit", value: true } },
        proof_conditioned_first_exposure: { any_at_10: { status: "miss", value: false } }
      }
    });
    expect(withoutProof.measurement && "request" in withoutProof.measurement
      ? "execution_receipt" in withoutProof.measurement.request : true).toBe(false);
    expect(REQUEST.page_budget).not.toBe(SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET);
    expect(withoutProof.measurement && "metrics" in withoutProof.measurement
      ? withoutProof.measurement.metrics.mixed_kind_first_exposure.any_at_10
      : null).not.toEqual(withoutProof.measurement && "metrics" in withoutProof.measurement
      ? withoutProof.measurement.metrics.proof_conditioned_first_exposure.any_at_10
      : undefined);
    const { response } = nativeProofResponseFixture();
    const labelOnly = { ...response, proofs: [] };
    const rejected = measureSourceSemanticLibraryResponse({
      recallResult: labelOnly, firstExposurePage: recordSourceSemanticLibraryFirstExposure(response),
      requestBudget: REQUEST, goldSourceUnits: [GOLD]
    });
    expect(rejected).toMatchObject({
      measurement: { status: "invalid" }, sourceBearingUnion: null, validatedProofRanks: []
    });
    expect(measureConditionalFieldResponse({ recallResult: labelOnly, deliveredResults: [] })?.status)
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
