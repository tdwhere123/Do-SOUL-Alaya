import { afterEach, expect, it, vi } from "vitest";
vi.hoisted(() => {
  for (const key of Object.keys(process.env)) if (/API_KEY|TOKEN|SECRET/u.test(key)) delete process.env[key];
  const nativeFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (new URL(String(input)).hostname !== "127.0.0.1" || init?.redirect !== "error") throw new Error("only no-redirect loopback transport allowed");
    return nativeFetch(input, init);
  });
});
import * as core from "@do-soul/alaya-core";
import { REQUEST, nativeMultiProofResponseFixture } from "./source-semantic-library-measurement-fixture.js";
import { recordSourceSemanticLibraryFirstExposure } from "../../../runs/measurement/source-semantic-library-recall.js";
import { measureSourceSemanticLibraryResponse, readmitSourceSemanticLibraryMeasurement } from
  "../../../runs/measurement/source-semantic-library-measurement.js";

afterEach(() => vi.restoreAllMocks());

it.each(["worker", "public"] as const)("verifies every independent proof at its occupied root in %s delivery", surface => {
  const fixture = nativeMultiProofResponseFixture();
  const recallResult = surface === "worker" ? fixture.worker : fixture.response;
  const firstExposurePage = recordSourceSemanticLibraryFirstExposure(recallResult);
  const input = { recallResult, firstExposurePage, requestBudget: REQUEST,
    goldSourceUnits: fixture.gold, sourceRecords: fixture.records };
  const verify = vi.spyOn(core, "deliveredSourceSemanticLibraryProof");
  const before = JSON.stringify(input);
  const evaluated = measureSourceSemanticLibraryResponse(input);
  expect(recallResult.slot_qualifiers?.map(qualifier => qualifier.index)).toEqual([0, 0, 0, 1, 2]);
  expect(firstExposurePage.initial?.slots.map(slot => [slot.rank, slot.object_kind])).toEqual([
    [1, "semantic_proof"], [2, "source_evidence"], [3, "semantic_proof"]
  ]);
  expect(verify).toHaveBeenCalledTimes(4);
  expect(verify.mock.calls.map(([, entry, qualifier]) => [entry.target, qualifier.index])).toEqual([
    [recallResult.index!.entries[0]!.target, 0], [recallResult.index!.entries[0]!.target, 0],
    [recallResult.index!.entries[0]!.target, 0], [recallResult.index!.entries[2]!.target, 2]
  ]);
  expect(verify.mock.results.map(result => result.type === "return" ? result.value.verified_proofs.length : -1)).toEqual([1, 1, 1, 1]);
  expect(evaluated.validatedProofRanks).toEqual([1, 3]);
  expect(evaluated.evaluator_usage.proof_slots_checked).toBe(4);
  expect(evaluated.measurement).toMatchObject({ status: "validated", metrics: {
    mixed_kind_first_exposure: { joined_unit_count: 1 }, proof_conditioned_first_exposure: { joined_unit_count: 2 },
    delivered_slot_union: { joined_unit_count: 3, any_at_5: { status: "hit" } }
  } });
  expect(evaluated.evaluator_usage.work_units).toBe(verify.mock.results.reduce((sum, result) =>
    sum + (result.type === "return" ? result.value.resource_usage.work_units : 0), 0));
  expect(evaluated.evaluator_usage.logical_memory_bytes).toBeGreaterThan(0);
  verify.mockClear();
  expect(readmitSourceSemanticLibraryMeasurement(evaluated.measurement, input)).toEqual(evaluated);
  expect(verify).toHaveBeenCalledTimes(4);
  expect(JSON.stringify(input)).toBe(before);
});

it("uses declared root indexes when qualifier order changes without reordering first exposure", () => {
  const fixture = nativeMultiProofResponseFixture();
  const recallResult = { ...fixture.response, slot_qualifiers: [...fixture.response.slot_qualifiers!].reverse() };
  const firstExposurePage = recordSourceSemanticLibraryFirstExposure(fixture.response);
  const evaluated = measureSourceSemanticLibraryResponse({ recallResult, firstExposurePage,
    requestBudget: REQUEST, goldSourceUnits: fixture.gold, sourceRecords: fixture.records });
  expect(evaluated.measurement?.status).toBe("validated");
  expect([...evaluated.validatedProofRanks].sort()).toEqual([1, 3]);
  expect(evaluated.evaluator_usage.proof_slots_checked).toBe(4);
  expect(evaluated.measurement?.status === "validated" && evaluated.measurement.first_exposure_page).toEqual(firstExposurePage);
});

it.each(["count", "tense"] as const)("retains %s partials as conditional evidence without certifying a complete answer", partial => {
  const fixture = nativeMultiProofResponseFixture(partial);
  const evaluated = measureSourceSemanticLibraryResponse({ recallResult: fixture.response,
    firstExposurePage: recordSourceSemanticLibraryFirstExposure(fixture.response),
    requestBudget: REQUEST, goldSourceUnits: fixture.gold, sourceRecords: fixture.records });
  expect(evaluated.measurement?.status).toBe("validated");
  expect(evaluated.validatedProofRanks).toEqual([1, 3]);
  expect(evaluated.evaluator_usage.proof_slots_checked).toBe(4);
  expect(fixture.response.proofs?.every(proof => proof.binding_results!.every(binding => !binding.query_complete))).toBe(true);
  expect(fixture.response.slot_qualifiers?.filter(qualifier => qualifier.evidence_kind === "semantic_proof")
    .every(qualifier => qualifier.support?.answer === "open")).toBe(true);
  expect(evaluated.sourceBearingUnion?.joined_unit_count).toBe(3);
});

it.each(["source_interpretation_id", "semantic_correspondence_id", "conditional_computation_id", "witnesses", "support"] as const)(
  "rejects an unmatched %s proof without borrowing another proof at the same root", field => {
    const fixture = nativeMultiProofResponseFixture();
    const recallResult = structuredClone(fixture.response);
    const qualifier = recallResult.slot_qualifiers![1]!;
    if (field === "witnesses") Object.assign(qualifier, { witnesses: [{ ...qualifier.witnesses![0]!, binding_id: "foreign-binding" }] });
    else if (field === "support") Object.assign(qualifier, { support: { ...qualifier.support!, answer: "open" } });
    else Object.assign(qualifier, { [field]: `sha256:${"0".repeat(64)}` });
    const verify = vi.spyOn(core, "deliveredSourceSemanticLibraryProof");
    const evaluated = measureSourceSemanticLibraryResponse({ recallResult,
      firstExposurePage: recordSourceSemanticLibraryFirstExposure(fixture.response), requestBudget: REQUEST,
      goldSourceUnits: fixture.gold, sourceRecords: fixture.records });
    expect(evaluated.measurement?.status).toBe("invalid");
    expect(evaluated.sourceBearingUnion).toBeNull();
    expect(evaluated.validatedProofRanks).toEqual([]);
    expect(verify).not.toHaveBeenCalled();
  });

it("keeps an unverified later gold root unknown even when an earlier root has multiple validated proofs", () => {
  const fixture = nativeMultiProofResponseFixture();
  const evaluated = measureSourceSemanticLibraryResponse({ recallResult: fixture.response,
    firstExposurePage: recordSourceSemanticLibraryFirstExposure(fixture.response), requestBudget: REQUEST,
    goldSourceUnits: [fixture.gold[2]!], sourceRecords: [fixture.records[0]!] });
  expect(evaluated.measurement?.status).toBe("validated");
  expect(evaluated.validatedProofRanks).toEqual([1]);
  expect(evaluated.sourceBearingUnion).toMatchObject({ joined_unit_count: 0,
    any_at_1: { status: "miss" }, any_at_5: { status: "unavailable" } });
});

it.each(["missing_root", "outside_root", "wrong_kind", "duplicate_source", "duplicate_proof"] as const)(
  "rejects %s qualifiers before proof verification", mutation => {
    const fixture = nativeMultiProofResponseFixture();
    const qualifiers = [...fixture.response.slot_qualifiers!];
    if (mutation === "missing_root") qualifiers.pop();
    else if (mutation === "outside_root") qualifiers[4] = { ...qualifiers[4]!, index: 3 };
    else if (mutation === "wrong_kind") qualifiers[3] = { ...qualifiers[0]!, index: 1 };
    else qualifiers.push(qualifiers[mutation === "duplicate_source" ? 3 : 0]!);
    const recallResult = { ...fixture.response, slot_qualifiers: qualifiers };
    const verify = vi.spyOn(core, "deliveredSourceSemanticLibraryProof");
    const evaluated = measureSourceSemanticLibraryResponse({ recallResult,
      firstExposurePage: recordSourceSemanticLibraryFirstExposure(recallResult), requestBudget: REQUEST,
      goldSourceUnits: fixture.gold, sourceRecords: fixture.records });
    expect(evaluated.measurement?.status).toBe("invalid");
    expect(evaluated.sourceBearingUnion).toBeNull();
    expect(verify).not.toHaveBeenCalled();
  });
