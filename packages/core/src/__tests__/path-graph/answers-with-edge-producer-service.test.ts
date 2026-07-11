import { describe, expect, it } from "vitest";
import {
  AnswersWithEdgeProducerService,
  type AnswerCoRelevancePairSourcePort,
  type AnswersWithEdgeMintPort
} from "../../path-graph/producers/answers-with-edge-producer-service.js";
import { HqAnswerOverlapPairSource } from "../../path-graph/producers/hq-answer-overlap.js";
import type { PathMintOutcome, SubmitCandidateInput } from "../../path-graph/edge-proposals/path-relation-proposal-service.js";

function pairSourceOf(pairs: readonly string[]): AnswerCoRelevancePairSourcePort {
  return { answerCoRelevantPairKeys: async () => new Set(pairs) };
}

function recordingMintPort(outcome: PathMintOutcome = "applied"): {
  readonly port: AnswersWithEdgeMintPort;
  readonly calls: SubmitCandidateInput[];
} {
  const calls: SubmitCandidateInput[] = [];
  return {
    calls,
    port: {
      submitCandidate: async (input) => {
        calls.push(input);
        return outcome;
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
    const mint = recordingMintPort();
    const producer = new AnswersWithEdgeProducerService({ pairSource: pairSourceOf(["a|b"]), mintPort: mint.port });
    const result = await producer.crystallize({
      workspaceId: "ws",
      runId: null,
      objects: [{ objectId: "a", sessionId: "s1", formationKey: "formation:0" }],
      bar: 3,
      capPerNode: 3,
      crossSessionOnly: true
    });
    expect(result).toEqual({ coRelevantPairs: 0, keptPairs: 0, minted: 0 });
    expect(mint.calls).toHaveLength(0);
  });

  it("mints an answers_with edge with the seed-profile band and object anchors", async () => {
    const mint = recordingMintPort();
    const producer = new AnswersWithEdgeProducerService({ pairSource: pairSourceOf(["a|c"]), mintPort: mint.port });
    const result = await producer.crystallize({
      workspaceId: "ws",
      runId: "run-1",
      objects: OBJECTS,
      bar: 3,
      capPerNode: 3,
      crossSessionOnly: true
    });
    expect(result.minted).toBe(1);
    expect(mint.calls).toHaveLength(1);
    const call = mint.calls[0]!;
    expect(call.relationKind).toBe("answers_with");
    expect(call.governanceClass).toBe("recall_allowed");
    expect(call.initialStrength).toBe(0.5);
    expect(call.evidenceBasis).toEqual(["hq_answer_overlap"]);
    expect(call.recallBiasSign).toBe(1);
    expect(call.sourceAnchor).toEqual({ kind: "object", object_id: "a" });
    expect(call.targetAnchor).toEqual({ kind: "object", object_id: "c" });
    expect(call.runId).toBe("run-1");
  });

  it("drops same-session pairs when crossSessionOnly", async () => {
    const mint = recordingMintPort();
    const producer = new AnswersWithEdgeProducerService({
      pairSource: pairSourceOf(["a|b", "c|d", "a|c"]),
      mintPort: mint.port
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
    expect(mint.calls.map((c) =>
      `${c.sourceAnchor.kind === "object" ? c.sourceAnchor.object_id : ""}|${c.targetAnchor.kind === "object" ? c.targetAnchor.object_id : ""}`
    )).toEqual(["a|c"]);
  });

  it("caps partners per node", async () => {
    const mint = recordingMintPort();
    const objects = ["a", "b", "c", "d"].map((id, index) => ({
      objectId: id, sessionId: id, formationKey: `formation:${index}`
    }));
    const producer = new AnswersWithEdgeProducerService({
      pairSource: pairSourceOf(["a|b", "a|c", "a|d", "b|c", "b|d", "c|d"]),
      mintPort: mint.port
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
    expect(result.keptPairs).toBe(mint.calls.length);
  });

  it("fails open to empty when the pair source throws", async () => {
    const mint = recordingMintPort();
    const producer = new AnswersWithEdgeProducerService({
      pairSource: { answerCoRelevantPairKeys: async () => { throw new Error("hq store down"); } },
      mintPort: mint.port
    });
    const result = await producer.crystallize({
      workspaceId: "ws",
      runId: null,
      objects: OBJECTS,
      bar: 3,
      capPerNode: 3,
      crossSessionOnly: true
    });
    expect(result).toEqual({ coRelevantPairs: 0, keptPairs: 0, minted: 0 });
    expect(mint.calls).toHaveLength(0);
  });

  it("crystallizes over a real memory_hq pair source (HQ read -> overlap -> mint)", async () => {
    const mint = recordingMintPort();
    const hqRepo = {
      getHqByObjectIds: async (objectIds: readonly string[]) => {
        const all = new Map<string, readonly string[]>([
          ["a", ["What database does the user prefer for analytics?"]],
          ["c", ["Which analytics database did the user choose?"]],
          ["d", ["What hiking trail is the user's favorite?"]]
        ]);
        return new Map([...all].filter(([id]) => objectIds.includes(id)));
      }
    };
    const producer = new AnswersWithEdgeProducerService({
      pairSource: new HqAnswerOverlapPairSource(hqRepo),
      mintPort: mint.port
    });
    const result = await producer.crystallize({
      workspaceId: "ws",
      runId: null,
      objects: OBJECTS,
      bar: 3,
      capPerNode: 3,
      crossSessionOnly: true
    });
    // a (s1) and c (s2) share 3 content tokens cross-session; d shares too few.
    expect(result.minted).toBe(1);
    expect(mint.calls[0]!.relationKind).toBe("answers_with");
  });
});
