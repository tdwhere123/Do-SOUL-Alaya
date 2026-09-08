import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { digestRecallFieldIdentity } from "@do-soul/alaya-core";
import { OpenSemanticFactorFormationCaptureSchema } from "@do-soul/alaya-protocol";
import {
  OpenSemanticFactorActivationReceiptSchema,
  OpenSemanticFactorCompatibilityTraceSchema,
  OpenSemanticFactorCompositionReceiptSchema
} from "../../../../../harness/recall/semantic-factors/open-semantic-factor-diagnostics-schema.js";
import { OpenSemanticFactorCandidateActivationsSchema } from "../../../../../diagnostics/schema/field/open-semantic-candidate-activation-schema.js";
import { buildTreatmentExposureReceipts } from "../../../../../diagnostics/stage-attribution/exposure/build-receipts.js";
import { assertTreatmentExposureReceipt } from "../../../../../diagnostics/stage-attribution/exposure/contract.js";
import type { LongMemEvalQuestionDiagnostic } from "../../../../../diagnostics/schema/diagnostics-types.js";
import type { QuestionStageRow } from "../../../../../diagnostics/stage-attribution/types.js";

const PARTNER_KEY = "workspace_local:evidence_capsule:partner";

describe("archived treatment exposure receipt v4 reconstructed join", () => {
  it("preserves a historical reconstructed join attribution on the v4 receipt", () => {
    const fixture = reconstructedJoinFixture();
    expect(fixture.reconstructed.state).toBe("reconstructed");
    expect(OpenSemanticFactorCandidateActivationsSchema.parse(fixture.entries))
      .toEqual(fixture.entries);

    const [receipt] = buildTreatmentExposureReceipts({
      control: [controlArm()],
      treatment: [treatmentArm(fixture)],
      controlStages: [stage("q3-join")],
      treatmentStages: [stage("q3-join")]
    });

    expect(receipt?.candidate_attribution.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          candidate_key: PARTNER_KEY,
          receipt: expect.objectContaining({ state: "reconstructed" })
        })
      ])
    );
    expect(() => assertTreatmentExposureReceipt(receipt!)).not.toThrow();
  });

  it("rejects an unknown activation state on an otherwise digest-valid receipt", () => {
    const { reconstructed } = reconstructedJoinFixture();
    const { receipt_digest: _digest, ...body } = reconstructed;
    const forged = {
      ...body,
      state: "inferred"
    };
    const parsed = OpenSemanticFactorCandidateActivationsSchema.safeParse([{
      candidate_key: PARTNER_KEY,
      receipt: {
        ...forged,
        receipt_digest: digestRecallFieldIdentity(forged)
      }
    }]);
    expect(parsed.success).toBe(false);
  });
});


function reconstructedJoinFixture() {
  const raw: Record<string, unknown> = JSON.parse(readFileSync(
    new URL("./receipt-v4-reconstructed-join.fixture.json", import.meta.url), "utf8"
  ));
  const entries = OpenSemanticFactorCandidateActivationsSchema.parse(raw.entries);
  return {
    query: OpenSemanticFactorFormationCaptureSchema.parse(raw.query),
    trace: OpenSemanticFactorCompatibilityTraceSchema.parse(raw.trace),
    composition: OpenSemanticFactorCompositionReceiptSchema.parse(raw.composition),
    activation: OpenSemanticFactorActivationReceiptSchema.parse(raw.activation),
    entries,
    reconstructed: entries[0]!.receipt
  };
}

function treatmentArm(fixture: ReturnType<typeof reconstructedJoinFixture>) {
  return {
    question_id: "q3-join",
    candidate_pool_complete: true,
    candidates: [{
      candidate_key: PARTNER_KEY,
      final_rank: 1,
      selection_order: 1,
      admission_attempts: [{ admitted: true }]
    }],
    query_open_semantic_factor_formation: fixture.query,
    open_semantic_factor_compatibility_trace: fixture.trace,
    open_semantic_factor_composition: fixture.composition,
    open_semantic_factor_activation: fixture.activation,
    open_semantic_factor_candidate_activations: fixture.entries
  } as unknown as LongMemEvalQuestionDiagnostic;
}

function controlArm() {
  return {
    question_id: "q3-join",
    candidate_pool_complete: true,
    candidates: [{ candidate_key: PARTNER_KEY, final_rank: 1 }],
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
