import { describe, expect, it } from "vitest";
import { SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET } from "@do-soul/alaya-protocol";
import { encodeSourceSemanticLibraryResponse } from "@do-soul/alaya-core";
import { REQUEST, GOLD, GOLD_TARGET, sourceOnly, proofEntry, assemble, workerRecall } from "./source-semantic-library-measurement-fixture.js";
import { measureConditionalFieldResponse } from "../../../runs/measurement/conditional-field-measurement.js";
import { recordSourceSemanticLibraryFirstExposure } from "../../../runs/measurement/source-semantic-library-recall.js";
import {
  measureSourceSemanticLibraryResponse, sourceSemanticLibraryProofAdmission, SourceSemanticLibraryMeasurementSchema
} from "../../../runs/measurement/source-semantic-library-measurement.js";
import {
  PROOF_CONDITIONED_FIRST_EXPOSURE_CONTRACT,
  scoreMixedKindFirstExposure, scoreProofConditionedFirstExposure, scoreSourceBearingUnionFirstExposure
} from "../../../runs/measurement/source-gold-join.js";
import { exposureSlots } from "../../../runs/measurement/first-exposure-session.js";
import { soulSearchFromLibraryRecall } from "../../../runs/measurement/source-semantic-library-recall.js";

function measureOf(result: ReturnType<typeof workerRecall>) {
  return measureSourceSemanticLibraryResponse({
    recallResult: result,
    firstExposurePage: recordSourceSemanticLibraryFirstExposure(result),
    requestBudget: REQUEST,
    goldSourceUnits: [GOLD]
  });
}

describe("source semantic library measurement", () => {
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
        .toMatchObject({ status: "invalid" });
      if (kind === "total_count" || kind === "missing_results" || kind === "missing_total_count") return;
      const slots = exposureSlots(soulSearchFromLibraryRecall(response));
      const admission = sourceSemanticLibraryProofAdmission(slots, response.index, response.slot_qualifiers, [], [GOLD], [], REQUEST);
      expect(admission.status).toBe("invalid");
      expect(scoreSourceBearingUnionFirstExposure(slots, [GOLD], admission).any_at_5.status).toBe("unavailable");
    });

  it("rejects a self-consistent stored exposure and metric for a root absent from the native index", () => {
    const response = encodeSourceSemanticLibraryResponse(workerRecall(assemble([sourceOnly("other")], [proofEntry("unverified")])));
    if (response.operation !== "recall" || response.results === undefined) throw new Error("native public recall expected");
    const measured = measureSourceSemanticLibraryResponse({ recallResult: response,
      firstExposurePage: recordSourceSemanticLibraryFirstExposure(response), requestBudget: REQUEST, goldSourceUnits: [GOLD] });
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
    expect(SourceSemanticLibraryMeasurementSchema.safeParse(changed).success).toBe(false);
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
    const measured = measureOf(workerRecall(assemble([sourceOnly("gold")], [proofEntry("other")])));
    expect(measured).toMatchObject({ status: "validated", metrics: {
      mixed_kind_first_exposure: { any_at_5: { status: "hit" } },
      proof_conditioned_first_exposure: { any_at_5: { status: "unavailable" } }
    } });
    if (measured?.status !== "validated") throw new Error("consistent native page expected");
    const admission = sourceSemanticLibraryProofAdmission(measured.first_exposure_slots, measured.delivered_index,
      measured.slot_qualifiers, measured.delivered_proofs, measured.source_gold_units, [], measured.request.budget);
    expect(admission.status).toBe("admitted");
    expect(admission.validatedRanks.size).toBe(0);
    expect(scoreSourceBearingUnionFirstExposure(measured.first_exposure_slots, measured.source_gold_units, admission).any_at_5.status)
      .toBe("hit");
  });

  it("scores mixed source retrieval but rejects label-only proof claims", () => {
    const withProof = measureOf(workerRecall(assemble([sourceOnly("gold")], [proofEntry("gold")])));
    const withoutProof = measureOf(workerRecall(assemble([sourceOnly("gold")], [])));
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
    const proofAdmission = sourceSemanticLibraryProofAdmission(withProof.first_exposure_slots, withProof.delivered_index,
      withProof.slot_qualifiers, withProof.delivered_proofs, withProof.source_gold_units, [], withProof.request.budget);
    expect(proofAdmission.validatedRanks.size).toBe(0);
    expect(proofAdmission.unverifiedGoldRanks.size).toBeGreaterThan(0);
    expect(scoreSourceBearingUnionFirstExposure(withProof.first_exposure_slots, withProof.source_gold_units, proofAdmission).any_at_5.status)
      .toBe("unavailable");
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

  it("fails closed when the index page_budget is not the library page", () => {
    const recalled = workerRecall(assemble([sourceOnly("gold")], []));
    const disagreed = {
      ...recalled,
      index: {
        ...recalled.index,
        representation: { ...recalled.index.representation, page_budget: REQUEST.page_budget }
      }
    };
    expect(measureSourceSemanticLibraryResponse({
      recallResult: disagreed,
      firstExposurePage: recordSourceSemanticLibraryFirstExposure(recalled),
      requestBudget: REQUEST,
      goldSourceUnits: [GOLD]
    })).toEqual({ schema_version: 1, status: "invalid", reason: "request_budget_mismatch" });
  });
});
