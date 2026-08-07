import { describe, expect, it } from "vitest";
import {
  AnswersWithEdgeProducerService,
  type AnswerCoRelevancePairSourcePort,
  type AnswerCoRelevancePairWitness,
  type AnswersWithRelationAssertionPort
} from "../../path-graph/producers/answers-with-edge-producer-service.js";
import { HqAnswerOverlapPairSource } from "../../path-graph/producers/hq-answer-overlap.js";
import type {
  RelationAssertionAdmissionRequest,
  RelationAssertionAdmissionResult
} from "../../path-graph/relation-assertions/relation-assertion-service-types.js";

const OBSERVED_AT = "2026-07-17T01:00:00.000Z";

function pairSourceOf(pairs: readonly string[]): AnswerCoRelevancePairSourcePort {
  return { answerCoRelevantPairs: async () => pairs.map(pairWitness) };
}

function pairWitness(key: string): AnswerCoRelevancePairWitness {
  const [left, right] = key.split("|") as [string, string];
  const evidenceReceipts = [left, right].map((objectId) => ({
    evidence_id: `evidence-${objectId}`,
    source_event_anchor: {
      event_type: "soul.signal.emitted",
      event_id: `event-${objectId}`,
      occurred_at: OBSERVED_AT
    }
  }));
  const decision = { shared_token_count: 3, shared_token_sha256: "d".repeat(64) };
  return {
    pair: [left, right],
    evidenceReceipts,
    formationReceipt: {
      operator_id: "hq_answer_overlap_v1",
      operator_sha256: "a".repeat(64),
      parameters: { bar: 3 },
      parameter_sha256: "b".repeat(64),
      source_observations: [left, right].map((objectId) => ({
        source_kind: "memory_hq_observation",
        source_id: `observation-${objectId}`,
        source_sha256: "c".repeat(64)
      })),
      decision,
      decision_sha256: "e".repeat(64)
    },
    validFrom: OBSERVED_AT
  };
}

function recordingAssertionPort(status: RelationAssertionAdmissionResult["status"] = "admitted"): {
  readonly port: AnswersWithRelationAssertionPort;
  readonly calls: RelationAssertionAdmissionRequest[];
} {
  const calls: RelationAssertionAdmissionRequest[] = [];
  return {
    calls,
    port: {
      admit: async (input) => {
        calls.push(input);
        return {
          status,
          assertion: {
            assertion_id: "assertion-1",
            workspace_id: input.workspaceId,
            admission_event_id: "admission-event-1",
            evidence_receipts: input.evidenceReceipts,
            formation_receipt: input.formationReceipt,
            anchors: input.anchors,
            relation_kind: input.relationKind,
            validity: input.validity,
            admitted_at: OBSERVED_AT
          },
          activeProjectionCount: 1,
          projectionGeneration: "projection-1"
        };
      }
    }
  };
}

const OBJECTS = [
  { objectId: "a", sessionId: "s1", formationKey: "formation:0" },
  { objectId: "b", sessionId: "s1", formationKey: "formation:1" },
  { objectId: "c", sessionId: "s2", formationKey: "formation:2" },
  { objectId: "d", sessionId: "s2", formationKey: "formation:3" }
];

describe("AnswersWithEdgeProducerService", () => {
  it("returns empty for fewer than two objects", async () => {
    const assertion = recordingAssertionPort();
    const producer = new AnswersWithEdgeProducerService({
      pairSource: pairSourceOf(["a|b"]),
      assertionPort: assertion.port
    });
    const result = await producer.crystallize({
      workspaceId: "ws",
      runId: null,
      objects: [{ objectId: "a", sessionId: "s1", formationKey: "formation:0" }],
      bar: 3,
      capPerNode: 3,
      crossSessionOnly: true
    });
    expect(result).toEqual({ coRelevantPairs: 0, keptPairs: 0, admitted: 0 });
    expect(assertion.calls).toHaveLength(0);
  });

  it("admits an evidence-grounded answers_with assertion", async () => {
    const assertion = recordingAssertionPort();
    const producer = new AnswersWithEdgeProducerService({
      pairSource: pairSourceOf(["a|c"]),
      assertionPort: assertion.port
    });
    const result = await producer.crystallize({
      workspaceId: "ws",
      runId: "run-1",
      objects: OBJECTS,
      bar: 3,
      capPerNode: 3,
      crossSessionOnly: true
    });
    expect(result.admitted).toBe(1);
    expect(assertion.calls).toHaveLength(1);
    expect(assertion.calls[0]).toMatchObject({
      relationKind: "answers_with",
      causedBy: "answers_with_edge_producer",
      validity: { kind: "open", valid_from: OBSERVED_AT },
      evidenceReceipts: [{ evidence_id: "evidence-a" }, { evidence_id: "evidence-c" }],
      formationReceipt: { operator_id: "hq_answer_overlap_v1", parameters: { bar: 3 } },
      anchors: {
        source_anchor: { kind: "object", object_id: "a" },
        target_anchor: { kind: "object", object_id: "c" }
      },
      runId: "run-1"
    });
  });

  it("drops same-session pairs when crossSessionOnly", async () => {
    const assertion = recordingAssertionPort();
    const producer = new AnswersWithEdgeProducerService({
      pairSource: pairSourceOf(["a|b", "c|d", "a|c"]),
      assertionPort: assertion.port
    });
    const result = await producer.crystallize({
      workspaceId: "ws",
      runId: null,
      objects: OBJECTS,
      bar: 3,
      capPerNode: 3,
      crossSessionOnly: true
    });
    expect(result.keptPairs).toBe(1);
    expect(assertion.calls.map((call) => `${call.anchors.source_anchor.kind === "object" ? call.anchors.source_anchor.object_id : ""}|${call.anchors.target_anchor.kind === "object" ? call.anchors.target_anchor.object_id : ""}`)).toEqual(["a|c"]);
  });

  it("caps partners per node", async () => {
    const assertion = recordingAssertionPort();
    const objects = ["a", "b", "c", "d"].map((id, index) => ({
      objectId: id, sessionId: id, formationKey: `formation:${index}`
    }));
    const producer = new AnswersWithEdgeProducerService({
      pairSource: pairSourceOf(["a|b", "a|c", "a|d", "b|c", "b|d", "c|d"]),
      assertionPort: assertion.port
    });
    const result = await producer.crystallize({
      workspaceId: "ws",
      runId: null,
      objects,
      bar: 3,
      capPerNode: 2,
      crossSessionOnly: true
    });
    expect(result.coRelevantPairs).toBe(6);
    expect(result.keptPairs).toBeLessThan(6);
    expect(result.keptPairs).toBe(assertion.calls.length);
  });

  it("fails closed to empty when the pair source throws", async () => {
    const assertion = recordingAssertionPort();
    const producer = new AnswersWithEdgeProducerService({
      pairSource: { answerCoRelevantPairs: async () => { throw new Error("hq store down"); } },
      assertionPort: assertion.port
    });
    const result = await producer.crystallize({
      workspaceId: "ws",
      runId: null,
      objects: OBJECTS,
      bar: 3,
      capPerNode: 3,
      crossSessionOnly: true
    });
    expect(result).toEqual({ coRelevantPairs: 0, keptPairs: 0, admitted: 0 });
    expect(assertion.calls).toHaveLength(0);
  });

  it("forms a witness over immutable HQ observations", async () => {
    const assertion = recordingAssertionPort();
    const hqRepo = {
      getObservationsByObjectIds: async (objectIds: readonly string[]) => {
        const all = new Map(["a", "c", "d"].map((id) => [id, {
          ...observation(id),
          hqs: id === "a"
            ? ["What database does the user prefer for analytics?"]
            : id === "c"
              ? ["Which analytics database did the user choose?"]
              : ["What hiking trail is the user's favorite?"]
        }]));
        return new Map([...all].filter(([id]) => objectIds.includes(id)));
      }
    };
    const producer = new AnswersWithEdgeProducerService({
      pairSource: new HqAnswerOverlapPairSource(hqRepo),
      assertionPort: assertion.port
    });
    const result = await producer.crystallize({
      workspaceId: "ws",
      runId: null,
      objects: OBJECTS,
      bar: 3,
      capPerNode: 3,
      crossSessionOnly: true
    });
    expect(result.admitted).toBe(1);
    expect(assertion.calls[0]!.formationReceipt.source_observations).toHaveLength(2);
  });
});

function observation(objectId: string) {
  return {
    observation_id: `observation-${objectId}`,
    object_id: objectId,
    workspace_id: "ws",
    hqs: [] as readonly string[],
    evidence_receipt: pairWitness(`${objectId}|z`).evidenceReceipts[0]!,
    hq_content_sha256: "f".repeat(64),
    observation_sha256: "e".repeat(64)
  };
}
