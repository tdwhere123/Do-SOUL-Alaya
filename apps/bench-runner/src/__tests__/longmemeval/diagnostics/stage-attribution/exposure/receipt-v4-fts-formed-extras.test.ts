import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { OpenSemanticFactorFormationCaptureSchema } from "@do-soul/alaya-protocol";
import { OpenSemanticFactorCompositionReceiptSchema } from "../../../../../harness/recall/semantic-factors/open-semantic-factor-diagnostics-schema.js";
import { buildTreatmentExposureReceipts } from "../../../../../diagnostics/stage-attribution/exposure/build-receipts.js";
import { assertTreatmentExposureReceipt } from "../../../../../diagnostics/stage-attribution/exposure/contract.js";
import type { LongMemEvalQuestionDiagnostic } from "../../../../../diagnostics/schema/diagnostics-types.js";
import type { QuestionStageRow } from "../../../../../diagnostics/stage-attribution/types.js";

const EXTRA = "daily commute";

describe("treatment exposure receipt v4 FTS extras", () => {
  it("preserves archived formed extras with no_match composition", () => {
    const raw = JSON.parse(readFileSync(new URL("./receipt-v4-fts-formed-extras.fixture.json", import.meta.url), "utf8"));
    const formed = OpenSemanticFactorFormationCaptureSchema.parse(raw.formed);
    const composition = OpenSemanticFactorCompositionReceiptSchema.parse(raw.composition);
    const treatmentTerms = z.array(z.string()).parse(raw.treatmentTerms);
    const controlTerms = z.array(z.string()).parse(raw.controlTerms);
    expect(formed.status).toBe("formed");
    expect(composition.status).toBe("no_match");
    expect(treatmentTerms).toEqual(expect.arrayContaining([EXTRA]));
    expect(controlTerms).not.toContain(EXTRA);

    const [receipt] = buildTreatmentExposureReceipts({
      control: [arm("q-fts-extra", controlTerms)],
      treatment: [{
        ...arm("q-fts-extra", treatmentTerms),
        query_open_semantic_factor_formation: formed,
        open_semantic_factor_composition: composition
      } as LongMemEvalQuestionDiagnostic],
      controlStages: [stage("q-fts-extra")],
      treatmentStages: [stage("q-fts-extra")]
    });

    expect(receipt).toMatchObject({
      formation: { status: "formed" },
      composition: { status: "no_match", solution_count: 0 },
      query_probe_delta: {
        observed: true,
        changed: true,
        added_expanded_terms: expect.arrayContaining([EXTRA]),
        removed_expanded_terms: []
      }
    });
    expect(receipt?.query_probe_delta.added_expanded_terms).toContain(EXTRA);
    expect(() => assertTreatmentExposureReceipt(receipt!)).not.toThrow();
  });
});

function arm(questionId: string, expandedTerms: readonly string[]) {
  return {
    question_id: questionId,
    candidate_pool_complete: true,
    candidates: [{ candidate_key: "candidate:a", final_rank: 1 }],
    query_probes: { expanded_terms: expandedTerms },
    open_semantic_factor_candidate_activations: []
  } as unknown as LongMemEvalQuestionDiagnostic;
}

function stage(questionId: string): QuestionStageRow {
  return {
    question_id: questionId,
    stage: "delivered_top5",
    mechanism: null,
    opportunity_pre_budget_6_10: false,
    miss_taxonomy: null,
    best_pool_rank: null,
    hit_at_5: true,
    proof: "hit_at_5"
  };
}
