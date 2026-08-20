import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID,
  certifyQueryOsfSemanticCompleteness
} from "@do-soul/alaya-protocol";
import { RuleBasedQueryFactFrameExtractor } from
  "../../../../shared/query-fact-frame-extraction-rules.js";
import { captureRecallQueryFactFrames } from
  "../../../../recall/field/query-attribution/query-fact-frame-attribution-producer.js";
import { deriveQueryFactFrameOsfObligation } from
  "../../../../recall/field/open-semantic-factors/query-obligation.js";
import { materializeOpenSemanticFactorFormation } from
  "../../../../semantic/open-semantic-factor-formation.js";
import { materializeOpenSemanticFactorCompatibilityTrace } from
  "../../../../recall/field/open-semantic-factors/compatibility-trace.js";
import { materializeOpenSemanticFactorComposition } from
  "../../../../recall/field/open-semantic-factors/composition.js";
import { materializeOpenSemanticFactorActivation } from
  "../../../../recall/field/open-semantic-factors/activation.js";
import { warmCjkSegmentation } from "../../../../shared/cjk-segmentation.js";

const QUERY = "我在哪里兑换了咖啡奶精优惠券？";
const TAIL = "咖啡奶精优惠券";

describe("certified CJK where obligation contract", () => {
  beforeAll(async () => {
    const ready = await warmCjkSegmentation();
    if (!ready) throw new Error("jieba unavailable in test env; native binding missing");
  });

  it("joins a reconstructed place through the obligation-certified query graph", async () => {
    const query = await certifiedWhereQuery();
    expect(query.formation.status).toBe("formed");
    expect(query.obligation.value.surface).toBe("哪里");
    const formations = {
      redeem: redeemEvidence(),
      partner: partnerEvidence()
    };
    const trace = materializeOpenSemanticFactorCompatibilityTrace({
      query_capture: query.formation,
      evidence_formations: formations
    });
    const composition = materializeOpenSemanticFactorComposition({
      trace,
      query_capture: query.formation,
      evidence_formations: formations
    });
    expect(composition).toMatchObject({
      status: "composed",
      solution_count: 1
    });
    expect(composition.solutions[0]?.result_bindings[0]).toMatchObject({
      variable_id: "answer",
      semantic_identity: "target"
    });
    expect(materializeOpenSemanticFactorActivation({
      composition, trace, query_capture: query.formation, evidence_formations: formations
    })).toMatchObject({
      status: "composed",
      entries: expect.arrayContaining([
        expect.objectContaining({ evidence_id: "redeem", state: "observed" }),
        expect.objectContaining({ evidence_id: "partner", state: "reconstructed" })
      ])
    });
  });
});

async function certifiedWhereQuery() {
  const factFrame = await captureRecallQueryFactFrames({
    query_text: QUERY,
    port: new RuleBasedQueryFactFrameExtractor()
  });
  const obligation = deriveQueryFactFrameOsfObligation({
    query_text: QUERY,
    fact_frame_capture: factFrame
  });
  if (obligation === null) throw new Error("expected where obligation");
  const constraint = obligation.constraints[0];
  if (constraint === undefined) throw new Error("expected where constraint");
  const graph = {
    schema_version: 2 as const,
    source_kind: "query" as const,
    factors: [
      factor("subject", obligation.subject.surface, obligation.subject.surface),
      factor("predicate", obligation.predicate.surface, obligation.predicate.surface),
      factor("tail", constraint.surface, constraint.surface)
    ],
    variables: [{ variable_id: "answer", surface: obligation.value.surface }],
    result_variable_ids: ["answer"],
    propositions: [{
      proposition_id: "redeem-query",
      predicate_factor_id: "predicate",
      arguments: [
        argument(0, "subject", "factor", "subject"),
        argument(1, "constraint", "factor", "tail"),
        argument(2, "location", "variable", "answer")
      ]
    }]
  };
  const receipt = certifyQueryOsfSemanticCompleteness({
    query_text: QUERY,
    graph,
    obligation,
    producer_operator_id: QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID,
    sha256
  });
  if (receipt === null) throw new Error("expected certified where graph");
  return {
    obligation,
    receipt,
    formation: materializeOpenSemanticFactorFormation({
      source_kind: "query",
      source_text: QUERY,
      proposal: {
        schema_version: 1,
        producer_operator_id: QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID,
        source_text: QUERY,
        graph
      }
    })
  };
}

function redeemEvidence() {
  return formation("evidence", `我上周兑换了${TAIL}。`, {
    schema_version: 2,
    source_kind: "evidence",
    factors: [
      factor("subject", "我", "我"),
      factor("predicate", "兑换", "兑换"),
      factor("tail", TAIL, TAIL),
      factor("when", "上周", "last sunday")
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
  return formation("evidence", `我在 Target 用了${TAIL}。`, {
    schema_version: 2,
    source_kind: "evidence",
    factors: [
      factor("subject", "我", "我"),
      factor("predicate", "用", "用"),
      factor("tail", TAIL, TAIL),
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

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
