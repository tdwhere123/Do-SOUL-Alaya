import { describe, expect, it } from "vitest";
import {
  CoherenceEdgeProducerService,
  type CoherenceEdgeMintPort,
  type CoherencePairSourcePort
} from "../../coherence-edge-producer-service.js";
import type { PathMintOutcome, SubmitCandidateInput } from "../../path-relation-proposal-service.js";

function pairSourceOf(pairs: readonly string[]): CoherencePairSourcePort {
  return {
    coherentPairKeys: async () => new Set(pairs)
  };
}

function recordingMintPort(outcome: PathMintOutcome = "applied"): {
  readonly port: CoherenceEdgeMintPort;
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
  { objectId: "a", sessionId: "s1" },
  { objectId: "b", sessionId: "s1" },
  { objectId: "c", sessionId: "s2" },
  { objectId: "d", sessionId: "s2" }
];

describe("CoherenceEdgeProducerService", () => {
  it("returns empty for fewer than two objects", async () => {
    const mint = recordingMintPort();
    const producer = new CoherenceEdgeProducerService({ pairSource: pairSourceOf(["a|b"]), mintPort: mint.port });
    const result = await producer.crystallize({
      workspaceId: "ws",
      runId: null,
      objects: [{ objectId: "a", sessionId: "s1" }],
      floor: 0.6,
      capPerNode: 3,
      crossSessionOnly: true
    });
    expect(result).toEqual({ coherentPairs: 0, keptPairs: 0, minted: 0 });
    expect(mint.calls).toHaveLength(0);
  });

  it("mints a coheres_with edge with auditable evidence and object anchors", async () => {
    const mint = recordingMintPort();
    const producer = new CoherenceEdgeProducerService({ pairSource: pairSourceOf(["a|c"]), mintPort: mint.port });
    const result = await producer.crystallize({
      workspaceId: "ws",
      runId: "run-1",
      objects: OBJECTS,
      floor: 0.6,
      capPerNode: 3,
      crossSessionOnly: true
    });
    expect(result.minted).toBe(1);
    expect(mint.calls).toHaveLength(1);
    const call = mint.calls[0]!;
    expect(call.relationKind).toBe("coheres_with");
    expect(call.evidenceBasis).toEqual(["embedding_cosine_coherence"]);
    expect(call.recallBiasSign).toBe(1);
    expect(call.sourceAnchor).toEqual({ kind: "object", object_id: "a" });
    expect(call.targetAnchor).toEqual({ kind: "object", object_id: "c" });
    expect(call.runId).toBe("run-1");
  });

  it("drops same-session pairs when crossSessionOnly", async () => {
    const mint = recordingMintPort();
    const producer = new CoherenceEdgeProducerService({
      // a|b (both s1) and c|d (both s2) are same-session; a|c crosses.
      pairSource: pairSourceOf(["a|b", "c|d", "a|c"]),
      mintPort: mint.port
    });
    const result = await producer.crystallize({
      workspaceId: "ws",
      runId: null,
      objects: OBJECTS,
      floor: 0.6,
      capPerNode: 3,
      crossSessionOnly: true
    });
    expect(result.keptPairs).toBe(1);
    expect(mint.calls.map((c) => `${c.sourceAnchor.kind === "object" ? c.sourceAnchor.object_id : ""}|${c.targetAnchor.kind === "object" ? c.targetAnchor.object_id : ""}`)).toEqual(["a|c"]);
  });

  it("caps partners per node", async () => {
    const mint = recordingMintPort();
    const objects = ["a", "b", "c", "d"].map((id) => ({ objectId: id, sessionId: id }));
    const producer = new CoherenceEdgeProducerService({
      // complete graph; capPerNode 2 keeps each node's 2 lexicographically-first partners.
      pairSource: pairSourceOf(["a|b", "a|c", "a|d", "b|c", "b|d", "c|d"]),
      mintPort: mint.port
    });
    const result = await producer.crystallize({
      workspaceId: "ws",
      runId: null,
      objects,
      floor: 0.6,
      capPerNode: 2,
      crossSessionOnly: true
    });
    expect(result.coherentPairs).toBe(6);
    expect(result.keptPairs).toBeLessThan(6);
    expect(result.keptPairs).toBe(mint.calls.length);
  });

  it("fails open to empty when the pair source throws", async () => {
    const mint = recordingMintPort();
    const producer = new CoherenceEdgeProducerService({
      pairSource: { coherentPairKeys: async () => { throw new Error("vector store down"); } },
      mintPort: mint.port
    });
    const result = await producer.crystallize({
      workspaceId: "ws",
      runId: null,
      objects: OBJECTS,
      floor: 0.6,
      capPerNode: 3,
      crossSessionOnly: true
    });
    expect(result).toEqual({ coherentPairs: 0, keptPairs: 0, minted: 0 });
    expect(mint.calls).toHaveLength(0);
  });
});
