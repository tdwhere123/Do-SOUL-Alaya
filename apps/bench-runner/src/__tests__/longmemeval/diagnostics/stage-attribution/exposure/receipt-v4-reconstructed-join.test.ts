import { describe, expect, it } from "vitest";
import { QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID } from "@do-soul/alaya-protocol";
import {
  digestRecallFieldIdentity,
  materializeOpenSemanticFactorFormation
} from "@do-soul/alaya-core";
import { materializeOpenSemanticFactorCompatibilityTrace } from
  "../../../../../../../../packages/core/src/recall/field/open-semantic-factors/compatibility-trace.js";
import { materializeOpenSemanticFactorComposition } from
  "../../../../../../../../packages/core/src/recall/field/open-semantic-factors/composition.js";
import { materializeOpenSemanticFactorActivation } from
  "../../../../../../../../packages/core/src/recall/field/open-semantic-factors/activation.js";
import { attributeOpenSemanticFactorActivations } from
  "../../../../../../../../packages/core/src/recall/field/open-semantic-factors/candidate-attribution.js";
import type { CoarseRecallCandidate } from
  "../../../../../../../../packages/core/src/recall/runtime/recall-service-types.js";
import { OpenSemanticFactorCandidateActivationsSchema } from
  "../../../../../bench/diagnostics/schema/field/open-semantic-candidate-activation-schema.js";
import { buildTreatmentExposureReceipts } from
  "../../../../../bench/diagnostics/stage-attribution/exposure/build-receipts.js";
import { assertTreatmentExposureReceipt } from
  "../../../../../bench/diagnostics/stage-attribution/exposure/contract.js";
import type { LongMemEvalQuestionDiagnostic } from
  "../../../../../bench/diagnostics/schema/diagnostics-types.js";
import type { QuestionStageRow } from
  "../../../../../bench/diagnostics/stage-attribution/types.js";

const QUERY = "Where did I redeem a $5 coupon on coffee creamer?";
const TAIL = "a $5 coupon on coffee creamer";
const PARTNER_KEY = "workspace_local:evidence_capsule:partner";

describe("treatment exposure receipt v4 reconstructed join", () => {
  it("seals a real Q3 reconstructed join attribution on the v4 receipt", () => {
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
  const query = whereQuery();
  const redeem = redeemEvidence();
  const partner = partnerEvidence();
  const formations = { redeem, partner };
  const trace = materializeOpenSemanticFactorCompatibilityTrace({
    query_capture: query,
    evidence_formations: formations
  });
  const composition = materializeOpenSemanticFactorComposition({
    trace,
    query_capture: query,
    evidence_formations: formations
  });
  const activation = materializeOpenSemanticFactorActivation({
    composition,
    trace,
    query_capture: query,
    evidence_formations: formations
  });
  const attributed = attributeOpenSemanticFactorActivations({
    candidates: [capsuleCandidate("partner")],
    activation
  });
  const reconstructed = attributed.get(PARTNER_KEY);
  if (reconstructed === undefined) {
    throw new Error("expected reconstructed partner attribution");
  }
  const entries = [{
    candidate_key: PARTNER_KEY,
    receipt: reconstructed
  }];
  return { query, trace, composition, activation, reconstructed, entries };
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

function whereQuery() {
  return formation("query", QUERY, {
    schema_version: 2,
    source_kind: "query",
    factors: [
      factor("subject", "I", "i"),
      factor("predicate", "redeem", "redeem"),
      factor("tail", TAIL, "coupon"),
      factor("aux", "did", "do")
    ],
    variables: [{ variable_id: "answer", surface: "Where" }],
    result_variable_ids: ["answer"],
    propositions: [{
      proposition_id: "redeem-query",
      predicate_factor_id: "predicate",
      arguments: [
        argument(0, "subject", "factor", "subject"),
        argument(1, "constraint", "factor", "tail"),
        argument(2, "location", "variable", "answer")
      ]
    }, {
      proposition_id: "extra-query",
      predicate_factor_id: "aux",
      arguments: [argument(0, "object", "factor", "tail")]
    }]
  }, QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID);
}

function redeemEvidence() {
  return formation("evidence", `I actually redeemed ${TAIL} last Sunday.`, {
    schema_version: 2,
    source_kind: "evidence",
    factors: [
      factor("subject", "I", "i"),
      factor("predicate", "redeemed", "redeem"),
      factor("tail", TAIL, "coupon"),
      factor("when", "last Sunday", "last sunday")
    ],
    variables: [],
    result_variable_ids: [],
    propositions: [{
      proposition_id: "redeem-event",
      predicate_factor_id: "predicate",
      arguments: [
        argument(0, "subject", "factor", "subject"),
        argument(1, "constraint", "factor", "tail"),
        argument(2, "time", "factor", "when")
      ]
    }]
  });
}

function partnerEvidence() {
  return formation("evidence", `I used ${TAIL} at Target.`, {
    schema_version: 2,
    source_kind: "evidence",
    factors: [
      factor("subject", "I", "i"),
      factor("predicate", "used", "use"),
      factor("tail", TAIL, "coupon"),
      factor("location", "Target", "target")
    ],
    variables: [],
    result_variable_ids: [],
    propositions: [{
      proposition_id: "use-event",
      predicate_factor_id: "predicate",
      arguments: [
        argument(0, "subject", "factor", "subject"),
        argument(1, "constraint", "factor", "tail"),
        argument(2, "location", "factor", "location")
      ]
    }]
  });
}

function capsuleCandidate(objectId: string) {
  return Object.freeze({
    entry: { object_id: objectId },
    originPlane: "workspace_local",
    objectKind: "evidence_capsule"
  }) as CoarseRecallCandidate;
}

function formation(
  sourceKind: "evidence" | "query",
  sourceText: string,
  graph: unknown,
  producerOperatorId = "open-factor-test-producer-v1"
) {
  return materializeOpenSemanticFactorFormation({
    source_kind: sourceKind,
    source_text: sourceText,
    proposal: {
      schema_version: 1,
      producer_operator_id: producerOperatorId,
      source_text: sourceText,
      graph
    }
  });
}

function factor(factorId: string, surface: string, semanticIdentity: string) {
  return { factor_id: factorId, surface, semantic_identity: semanticIdentity };
}

function argument(
  position: number,
  bindingIdentity: string,
  referenceKind: "factor" | "variable",
  referenceId: string
) {
  return {
    position,
    binding_identity: bindingIdentity,
    reference_kind: referenceKind,
    reference_id: referenceId
  };
}

function stage(questionId: string): QuestionStageRow {
  return {
    question_id: questionId,
    stage: 7,
    mechanism: null,
    opportunity_pre_budget_6_10: false,
    miss_taxonomy: null,
    best_pool_rank: null,
    hit_at_5: true,
    proof: "hit_at_5"
  };
}
