import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { warmCjkSegmentation } from "../../../../shared/cjk-segmentation.js";
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
import { materializeOpenSemanticFactorCompatibility } from
  "../../../../recall/field/open-semantic-factors/compatibility.js";
import { materializeOpenSemanticFactorCompatibilityTrace } from
  "../../../../recall/field/open-semantic-factors/compatibility-trace.js";
import { materializeOpenSemanticFactorComposition } from
  "../../../../recall/field/open-semantic-factors/composition.js";

const QUERY = "How long is my daily commute to work?";
const LISTEN = "I've been listening to audiobooks on my 45-minute daily commute to work.";
const CJK_QUERY = "每天上班通勤要多久？";

describe("certified copular duration obligation contract", () => {
  beforeAll(async () => {
    const ready = await warmCjkSegmentation();
    if (!ready) throw new Error("jieba unavailable in test env; native binding missing");
  });

  it("binds duration through the obligation-certified query graph", async () => {
    const query = await certifiedDurationQuery();
    expect(query.formation.status).toBe("formed");
    expect(query.receipt?.operator_id).toBe("query_osf_semantic_completeness_v2");
    const evidence = listenEvidence();
    const receipt = materializeOpenSemanticFactorCompatibility({
      evidence_capture: evidence,
      query_capture: query.formation
    });
    expect(receipt).toMatchObject({
      status: "compatible",
      matched_query_proposition_count: 1
    });
    expect(receipt.proposition_matches[0]?.predicate_alignment.operator_id)
      .toBe("duration_measure_binding_v1");
    const trace = materializeOpenSemanticFactorCompatibilityTrace({
      query_capture: query.formation,
      evidence_formations: { commute: evidence }
    });
    expect(materializeOpenSemanticFactorComposition({
      trace,
      query_capture: query.formation
    })).toMatchObject({
      status: "composed",
      solution_count: 1
    });
  });

  it("does not treat an uncertified how-many-hours surface as a copular measure", () => {
    const query = formation("query", "How many hours is my daily commute to work?", {
      schema_version: 2,
      source_kind: "query",
      factors: [
        factor("predicate", "is", "be"),
        factor("subject", "my daily commute to work", "my daily commute to work")
      ],
      variables: [{ variable_id: "answer", surface: "How many hours" }],
      result_variable_ids: ["answer"],
      propositions: [{
        proposition_id: "hours-query",
        predicate_factor_id: "predicate",
        arguments: [
          argument(0, "subject", "factor", "subject"),
          argument(1, "duration", "variable", "answer")
        ]
      }]
    }, QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID);
    expect(materializeOpenSemanticFactorCompatibility({
      evidence_capture: listenEvidence(),
      query_capture: query
    })).toMatchObject({
      status: "incompatible",
      matched_query_proposition_count: 0
    });
  });

  it.each(["四十五分钟", "45分钟"] as const)(
    "binds CJK evidence extent %s through formation, compatibility, and composition",
    async (extent) => {
      const query = await certifiedDurationQuery(CJK_QUERY);
      expect(query.formation.status).toBe("formed");
      expect(query.obligation.value.surface).toBe("多久");
      const evidence = cjkListenEvidence("每天上班通勤", extent);
      const receipt = materializeOpenSemanticFactorCompatibility({
        evidence_capture: evidence,
        query_capture: query.formation
      });
      expect(receipt).toMatchObject({
        status: "compatible",
        matched_query_proposition_count: 1
      });
      expect(receipt.proposition_matches[0]?.predicate_alignment.operator_id)
        .toBe("duration_measure_binding_v1");
      const trace = materializeOpenSemanticFactorCompatibilityTrace({
        query_capture: query.formation,
        evidence_formations: { commute: evidence }
      });
      expect(materializeOpenSemanticFactorComposition({
        trace,
        query_capture: query.formation
      })).toMatchObject({
        status: "composed",
        solution_count: 1
      });
    }
  );

  it.each([
    ["三岁", "age"],
    ["三点", "clock"],
    ["第二次", "ordinal leftover"],
    ["四十五公斤", "wrong unit"]
  ] as const)("rejects CJK %s evidence on the certified commute query", async (surface) => {
    const query = await certifiedDurationQuery(CJK_QUERY);
    expect(materializeOpenSemanticFactorCompatibility({
      evidence_capture: cjkListenEvidence("每天上班通勤", surface),
      query_capture: query.formation
    })).toMatchObject({
      status: "incompatible",
      matched_query_proposition_count: 0
    });
  });

  it("covers a Chinese subject by word pieces on longer evidence", () => {
    const query = formation("query", "How long is 每日通勤上班 route?", {
      schema_version: 2,
      source_kind: "query",
      factors: [
        factor("predicate", "is", "be"),
        factor("subject", "每日通勤上班", "每日通勤上班")
      ],
      variables: [{ variable_id: "answer", surface: "How long" }],
      result_variable_ids: ["answer"],
      propositions: [{
        proposition_id: "cjk-query",
        predicate_factor_id: "predicate",
        arguments: [
          argument(0, "subject", "factor", "subject"),
          argument(1, "duration", "variable", "answer")
        ]
      }]
    }, QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID);
    expect(materializeOpenSemanticFactorCompatibility({
      evidence_capture: cjkListenEvidence("每日通勤上班路程"),
      query_capture: query
    })).toMatchObject({
      status: "compatible",
      matched_query_proposition_count: 1
    });
  });
});

async function certifiedDurationQuery(queryText = QUERY) {
  const factFrame = await captureRecallQueryFactFrames({
    query_text: queryText,
    port: new RuleBasedQueryFactFrameExtractor()
  });
  const obligation = deriveQueryFactFrameOsfObligation({
    query_text: queryText,
    fact_frame_capture: factFrame
  });
  if (obligation === null) throw new Error("expected duration obligation");
  const graph = {
    schema_version: 2 as const,
    source_kind: "query" as const,
    factors: [
      factor("predicate", obligation.predicate.surface, "be"),
      factor("subject", obligation.subject.surface, obligation.subject.surface)
    ],
    variables: [{ variable_id: "answer", surface: obligation.value.surface }],
    result_variable_ids: ["answer"],
    propositions: [{
      proposition_id: "commute-query",
      predicate_factor_id: "predicate",
      arguments: [
        argument(0, "subject", "factor", "subject"),
        argument(1, "duration", "variable", "answer")
      ]
    }]
  };
  const receipt = certifyQueryOsfSemanticCompleteness({
    query_text: queryText,
    graph,
    obligation,
    producer_operator_id: QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID,
    sha256
  });
  if (receipt === null) throw new Error("expected certified duration graph");
  return {
    obligation,
    receipt,
    formation: materializeOpenSemanticFactorFormation({
      source_kind: "query",
      source_text: queryText,
      proposal: {
        schema_version: 1,
        producer_operator_id: QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID,
        source_text: queryText,
        graph
      }
    })
  };
}

function listenEvidence() {
  return formation("evidence", LISTEN, {
    schema_version: 2,
    source_kind: "evidence",
    factors: [
      factor("actor", "I", "i"),
      factor("predicate", "listening", "listen"),
      factor("object", "audiobooks", "audiobooks"),
      factor("duration", "45-minute", "45 minutes"),
      factor("commute", "daily commute to work", "daily commute to work")
    ],
    variables: [],
    result_variable_ids: [],
    propositions: [{
      proposition_id: "listen-event",
      predicate_factor_id: "predicate",
      arguments: [
        argument(0, "agent", "factor", "actor"),
        argument(1, "object", "factor", "object"),
        argument(2, "duration", "factor", "duration"),
        argument(3, "setting", "factor", "commute")
      ]
    }]
  });
}

function cjkListenEvidence(commute = "每天上班通勤", duration = "四十五分钟") {
  return formation("evidence", `我在${duration}的${commute}听书。`, {
    schema_version: 2,
    source_kind: "evidence",
    factors: [
      factor("predicate", "听", "listen"),
      factor("duration", duration, duration),
      factor("commute", commute, commute)
    ],
    variables: [],
    result_variable_ids: [],
    propositions: [{
      proposition_id: "listen-event",
      predicate_factor_id: "predicate",
      arguments: [
        argument(0, "duration", "factor", "duration"),
        argument(1, "setting", "factor", "commute")
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
