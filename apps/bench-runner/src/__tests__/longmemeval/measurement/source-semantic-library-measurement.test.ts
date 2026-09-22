import { describe, expect, it } from "vitest";
import { SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET } from "@do-soul/alaya-protocol";
import { REQUEST, GOLD, GOLD_TARGET, sourceOnly, proofEntry, assemble, workerRecall } from "./source-semantic-library-measurement-fixture.js";
import { measureConditionalFieldResponse } from "../../../runs/measurement/conditional-field-measurement.js";
import { recordSourceSemanticLibraryFirstExposure } from "../../../runs/measurement/source-semantic-library-recall.js";
import {
  measureSourceSemanticLibraryResponse
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

describe("source semantic library measurement", () => {
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
