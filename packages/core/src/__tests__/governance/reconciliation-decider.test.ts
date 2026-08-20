import { describe, expect, it, vi } from "vitest";
import type { MemoryEntry } from "@do-soul/alaya-protocol";
import { ReconciliationDecider } from "../../governance/reconciliation/reconciliation-decider.js";
import type { PreWriteCandidateNeighbor } from "../../governance/reconciliation/pre-write-recall-service.js";

function makeEntry(
  objectId: string,
  content: string,
  dimension: MemoryEntry["dimension"] = "fact"
): Readonly<MemoryEntry> {
  return {
    object_id: objectId,
    content,
    dimension,
    workspace_id: "ws-1",
    domain_tags: ["tag-1"],
    canonical_entities: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z"
  } as unknown as Readonly<MemoryEntry>;
}

describe("ReconciliationDecider candidate permutation invariance", () => {
  it("ambiguous candidate input permutations produce identical selected candidate content order", async () => {
    const candidateA: PreWriteCandidateNeighbor = {
      entry: makeEntry("id-1", "Zebra lives in savanna"),
      lexicalScore: 0.8,
      structuralScore: 0.8,
      families: ["domain_tag"],
      relationPosteriors: []
    };
    const candidateB: PreWriteCandidateNeighbor = {
      entry: makeEntry("id-2", "Apple lives in orchard"),
      lexicalScore: 0.8,
      structuralScore: 0.8,
      families: ["domain_tag"],
      relationPosteriors: []
    };

    const decideCalls: Array<readonly { readonly objectId: string; readonly content: string }[]> = [];
    const llmDecision = {
      decide: vi.fn(async ({ candidates }) => {
        decideCalls.push(candidates);
        return { kind: "add" as const, reason: "distinct" };
      })
    };

    const inputBase = {
      workspaceId: "ws-1",
      signalId: "sig-1",
      incomingContent: "Banana lives in garden",
      incomingDomainTags: ["tag-1"],
      incomingDimension: "fact" as const,
      incomingProjectionFields: {
        domain_tags: ["tag-1"],
        canonical_entities: [],
        typed_slots: {},
        temporal_anchors: []
      }
    };

    const decider1 = new ReconciliationDecider({
      preWriteRecall: {
        recall: async () => ({
          candidates: [candidateA, candidateB],
          uncertainty: 0.2,
          auditFeatures: {}
        })
      },
      llmDecision,
      similarityFloor: 0.35,
      conflictTagOverlapThreshold: 0.5,
      maxLlmCandidates: 4,
      warn: () => undefined
    });
    await decider1.decide(inputBase);

    const decider2 = new ReconciliationDecider({
      preWriteRecall: {
        recall: async () => ({
          candidates: [candidateB, candidateA],
          uncertainty: 0.2,
          auditFeatures: {}
        })
      },
      llmDecision,
      similarityFloor: 0.35,
      conflictTagOverlapThreshold: 0.5,
      maxLlmCandidates: 4,
      warn: () => undefined
    });
    await decider2.decide(inputBase);

    expect(decideCalls).toHaveLength(2);
    expect(decideCalls[0]).toEqual(decideCalls[1]);
  });
  it("identical NOOP target selection is invariant to neighbor candidate input permutation with two whitespace-normalized-identical rows", async () => {
    const candidateA: PreWriteCandidateNeighbor = {
      entry: makeEntry("id-2", "Zebra lives in savanna"),
      lexicalScore: 0.9,
      structuralScore: 0.9,
      families: ["domain_tag"],
      relationPosteriors: []
    };
    const candidateB: PreWriteCandidateNeighbor = {
      entry: makeEntry("id-1", "Zebra lives in savanna"),
      lexicalScore: 0.9,
      structuralScore: 0.9,
      families: ["domain_tag"],
      relationPosteriors: []
    };

    const decider1 = new ReconciliationDecider({
      preWriteRecall: {
        recall: async () => ({
          candidates: [candidateA, candidateB],
          uncertainty: 0.1,
          auditFeatures: {}
        })
      },
      llmDecision: { decide: vi.fn() },
      similarityFloor: 0.35,
      conflictTagOverlapThreshold: 0.5,
      maxLlmCandidates: 4,
      warn: () => undefined
    });
    const decision1 = await decider1.decide({
      workspaceId: "ws-1",
      signalId: "sig-1",
      incomingContent: "Zebra lives in savanna",
      incomingDomainTags: ["tag-1"],
      incomingDimension: "fact"
    });

    const decider2 = new ReconciliationDecider({
      preWriteRecall: {
        recall: async () => ({
          candidates: [candidateB, candidateA],
          uncertainty: 0.1,
          auditFeatures: {}
        })
      },
      llmDecision: { decide: vi.fn() },
      similarityFloor: 0.35,
      conflictTagOverlapThreshold: 0.5,
      maxLlmCandidates: 4,
      warn: () => undefined
    });
    const decision2 = await decider2.decide({
      workspaceId: "ws-1",
      signalId: "sig-1",
      incomingContent: "Zebra lives in savanna",
      incomingDomainTags: ["tag-1"],
      incomingDimension: "fact"
    });

    expect(decision1.kind).toBe("noop");
    expect(decision2.kind).toBe("noop");
    expect(decision1.survivingObjectId).toBe("id-1");
    expect(decision2.survivingObjectId).toBe("id-1");
    expect(decision1).toEqual(decision2);
  });

  it("keeps a normalized duplicate within the incoming memory dimension", async () => {
    const content = "The overhead lighting casts a shadow on the workspace.";
    const fact: PreWriteCandidateNeighbor = {
      entry: makeEntry("memory-z-fact", content, "fact"),
      lexicalScore: 1,
      structuralScore: 1,
      families: ["lexical"],
      relationPosteriors: []
    };
    const preference: PreWriteCandidateNeighbor = {
      entry: makeEntry("memory-a-preference", content, "preference"),
      lexicalScore: 1,
      structuralScore: 1,
      families: ["lexical"],
      relationPosteriors: []
    };
    const decide = async (candidates: readonly PreWriteCandidateNeighbor[]) => {
      const decider = new ReconciliationDecider({
        preWriteRecall: {
          recall: async () => ({ candidates, uncertainty: 0, auditFeatures: {} })
        },
        llmDecision: { decide: vi.fn() },
        similarityFloor: 0.35,
        conflictTagOverlapThreshold: 0.5,
        maxLlmCandidates: 4,
        warn: () => undefined
      });
      const input = {
        workspaceId: "ws-1",
        signalId: "sig-1",
        incomingContent: content,
        incomingDomainTags: ["tag-1"],
        incomingDimension: "fact" as const
      };
      return await decider.decide(input);
    };

    const [forward, reverse] = await Promise.all([
      decide([fact, preference]),
      decide([preference, fact])
    ]);

    expect(forward.survivingObjectId).toBe("memory-z-fact");
    expect(reverse.survivingObjectId).toBe("memory-z-fact");
  });
});
