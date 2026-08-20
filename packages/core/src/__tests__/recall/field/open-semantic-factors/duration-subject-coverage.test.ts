import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID } from "@do-soul/alaya-protocol";
import { materializeOpenSemanticFactorFormation } from
  "../../../../semantic/open-semantic-factor-formation.js";
import { materializeOpenSemanticFactorCompatibility } from
  "../../../../recall/field/open-semantic-factors/compatibility.js";
import {
  __resetCjkSegmentationStateForTests,
  __setCjkSegmentationLoaderForTests,
  warmCjkSegmentation
} from "../../../../shared/cjk-segmentation.js";

describe("duration subject word-piece coverage", () => {
  describe("when jieba is warm", () => {
    beforeAll(async () => {
      const ready = await warmCjkSegmentation();
      if (!ready) throw new Error("jieba unavailable in test env; native binding missing");
    });

    it("covers 每日通勤上班 with longer evidence 每日通勤上班路程", () => {
      expect(receipt("每日通勤上班", "每日通勤上班路程")).toMatchObject({
        status: "compatible",
        matched_query_proposition_count: 1
      });
    });

    it("keeps English subject coverage when evidence adds a trailing noun", () => {
      expect(receipt("daily commute to work", "daily commute to work route")).toMatchObject({
        status: "compatible",
        matched_query_proposition_count: 1
      });
    });

    it.each([
      ["每日吃饭", "unrelated commute"],
      ["每天喝茶", "distractor"],
      ["每日上班", "partial overlap"],
      ["每天不上班通勤", "negated commute"],
      ["非通勤", "negated commute prefix"],
      ["没上班", "negated work"],
      ["无通勤", "negated commute absence"]
    ] as const)("fails closed on CJK %s", (evidenceSubject) => {
      expect(receipt("每日通勤上班", evidenceSubject)).toMatchObject({
        status: "incompatible",
        matched_query_proposition_count: 0
      });
    });

    it("fails closed when English evidence drops a subject token", () => {
      expect(receipt("daily commute to work", "daily commute")).toMatchObject({
        status: "incompatible",
        matched_query_proposition_count: 0
      });
    });
  });

  describe("when jieba is cold", () => {
    beforeEach(() => {
      __setCjkSegmentationLoaderForTests(async () => null);
    });
    afterEach(() => {
      __resetCjkSegmentationStateForTests();
    });

    it("covers 每日通勤上班 with longer evidence 每日通勤上班路程", async () => {
      await expect(warmCjkSegmentation()).resolves.toBe(false);
      expect(receipt("每日通勤上班", "每日通勤上班路程")).toMatchObject({
        status: "compatible",
        matched_query_proposition_count: 1
      });
    });

    it("fails closed on a CJK distractor subject", async () => {
      await expect(warmCjkSegmentation()).resolves.toBe(false);
      expect(receipt("每日通勤上班", "每日吃饭")).toMatchObject({
        status: "incompatible",
        matched_query_proposition_count: 0
      });
    });

    it.each([
      ["每天不上班通勤"],
      ["非通勤"],
      ["没上班"],
      ["无通勤"]
    ] as const)("fails closed on cold CJK negation %s", async (evidenceSubject) => {
      await expect(warmCjkSegmentation()).resolves.toBe(false);
      expect(receipt("每日通勤上班", evidenceSubject)).toMatchObject({
        status: "incompatible",
        matched_query_proposition_count: 0
      });
    });
  });
});

function receipt(querySubject: string, evidenceSubject: string) {
  return materializeOpenSemanticFactorCompatibility({
    evidence_capture: commuteDuration(evidenceSubject),
    query_capture: copularQuery(querySubject)
  });
}

function copularQuery(subject: string) {
  return formation("query", `How long is ${subject}?`, {
    schema_version: 2,
    source_kind: "query",
    factors: [
      factor("predicate", "is", "be"),
      factor("subject", subject, subject)
    ],
    variables: [{ variable_id: "answer", surface: "How long" }],
    result_variable_ids: ["answer"],
    propositions: [{
      proposition_id: "commute-query",
      predicate_factor_id: "predicate",
      arguments: [
        argument(0, "subject", "factor", "subject"),
        argument(1, "duration", "variable", "answer")
      ]
    }]
  }, QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID);
}

function commuteDuration(subject: string) {
  return formation("evidence", `${subject} takes 45 minutes.`, {
    schema_version: 2,
    source_kind: "evidence",
    factors: [
      factor("predicate", "takes", "duration"),
      factor("subject", subject, subject),
      factor("value", "45 minutes", "45 minutes")
    ],
    variables: [],
    result_variable_ids: [],
    propositions: [{
      proposition_id: "duration-event",
      predicate_factor_id: "predicate",
      arguments: [
        argument(0, "subject", "factor", "subject"),
        argument(1, "duration", "factor", "value")
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
