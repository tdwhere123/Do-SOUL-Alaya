import { afterEach, describe, expect, it } from "vitest";
import {
  createFixture,
  seedClaimForm,
  seedEvidenceCapsule,
  seedMemoryEntry,
  seedRecallsPath,
  seedSynthesisCapsule,
  trackedDatabases
} from "./garden-data-ports-fixture.js";

const databases = trackedDatabases;

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

describe("garden background data ports bootstrapping and candidate scans", () => {
  it("assesses bootstrapping cold-start state and pattern candidate lifecycle", async () => {
    const { database, ports } = await createFixture();
    const coldStart = await ports.bootstrappingPort.assessColdStart("workspace-1");
    expect(coldStart).toEqual({
      is_cold_start: true,
      memory_count: 0,
      claim_count: 0
    });

    for (let index = 0; index < 12; index += 1) {
      seedMemoryEntry(database, {
        objectId: `memory-${index}`,
        workspaceId: "workspace-1",
        runId: "run-1",
        content: index < 4 ? "TypeScript rule" : `Memory ${index}`
      });
    }
    seedMemoryEntry(database, {
      objectId: "memory-inactive",
      workspaceId: "workspace-1",
      runId: "run-1",
      lifecycleState: "archived",
      content: "TypeScript rule"
    });
    seedMemoryEntry(database, {
      objectId: "memory-draft",
      workspaceId: "workspace-1",
      runId: "run-1",
      lifecycleState: "draft",
      content: "TypeScript rule"
    });
    for (let index = 0; index < 6; index += 1) {
      seedClaimForm(database, {
        objectId: `claim-${index}`,
        workspaceId: "workspace-1",
        evidenceRefs: [],
        sourceObjectRefs: [],
        canonicalKey: index < 4 ? "ts.rules" : `key-${index}`
      });
    }
    seedClaimForm(database, {
      objectId: "claim-inactive-draft",
      workspaceId: "workspace-1",
      evidenceRefs: [],
      sourceObjectRefs: [],
      canonicalKey: "ts.rules",
      lifecycleState: "archived",
      claimStatus: "draft"
    });

    const warmStart = await ports.bootstrappingPort.assessColdStart("workspace-1");
    expect(warmStart).toEqual({
      is_cold_start: false,
      memory_count: 12,
      claim_count: 6
    });

    const draftCandidates = await ports.bootstrappingPort.generateDraftCandidates("workspace-1");
    expect(draftCandidates.length).toBeGreaterThan(0);
    expect(draftCandidates.some((candidate) => candidate.candidate_id === "memory-0")).toBe(true);
    expect(draftCandidates.some((candidate) => candidate.candidate_id === "claim-inactive-draft")).toBe(false);
    expect(draftCandidates.some((candidate) => candidate.candidate_id === "memory-inactive")).toBe(false);
    expect(draftCandidates.some((candidate) => candidate.candidate_id === "memory-draft")).toBe(false);

    const patterns = await ports.bootstrappingPort.findHighFrequencyPatterns("workspace-1", 3);
    expect(patterns).toEqual(
      expect.arrayContaining([
        { pattern_key: "claim:ts.rules", frequency: 4 },
        { pattern_key: "memory:typescript rule", frequency: 4 }
      ])
    );

    expect(await ports.bootstrappingPort.hasPendingSynthesisCandidate("workspace-1", "claim:ts.rules")).toBe(false);
    const created = await ports.bootstrappingPort.createSynthesisCandidate("workspace-1", "claim:ts.rules");
    expect(created.candidate_id).not.toHaveLength(0);
    expect(await ports.bootstrappingPort.hasPendingSynthesisCandidate("workspace-1", "claim:ts.rules")).toBe(true);
  });

  it("finds and demotes Janitor hot-tier candidates", async () => {
    const { database, ports } = await createFixture();
    seedMemoryEntry(database, {
      objectId: "memory-demote",
      workspaceId: "workspace-1",
      runId: "run-1",
      activationScore: 0.1,
      lastHitAt: "2026-01-01T00:00:00.000Z"
    });
    seedMemoryEntry(database, {
      objectId: "memory-keep",
      workspaceId: "workspace-1",
      runId: "run-1",
      activationScore: 0.9,
      lastHitAt: "2026-01-01T00:00:00.000Z"
    });
    seedMemoryEntry(database, {
      objectId: "memory-reported-used",
      workspaceId: "workspace-1",
      runId: "run-1",
      activationScore: 0.1,
      lastHitAt: "2026-04-15T00:00:00.000Z"
    });

    const found = await ports.tieringPort.findHotDemotionCandidates("workspace-1", {
      maxLastHitAgeMs: 7 * 24 * 60 * 60 * 1000,
      minActivationScore: 0.3
    });
    expect(found.map((entry) => entry.memory_entry_id)).toEqual(["memory-demote"]);

    await ports.tieringPort.demoteToWarm("workspace-1", ["memory-demote"]);
    const row = database.connection
      .prepare("SELECT storage_tier FROM memory_entries WHERE object_id = ? LIMIT 1")
      .get("memory-demote") as { readonly storage_tier: string } | undefined;
    expect(row?.storage_tier).toBe("cold");

    const none = await ports.tieringPort.findHotDemotionCandidates("workspace-2", {
      maxLastHitAgeMs: 7 * 24 * 60 * 60 * 1000,
      minActivationScore: 0.3
    });
    expect(none).toEqual([]);
  });

  it("finds Librarian merge, neighbor, compression, and synthesis candidates", async () => {
    const { database, ports } = await createFixture();
    seedMemoryEntry(database, {
      objectId: "memory-a",
      workspaceId: "workspace-1",
      runId: "run-1",
      content: "Subject Alpha",
      dimension: "fact"
    });
    seedMemoryEntry(database, {
      objectId: "memory-b",
      workspaceId: "workspace-1",
      runId: "run-1",
      content: "Subject Alpha",
      dimension: "fact"
    });
    seedMemoryEntry(database, {
      objectId: "memory-c",
      workspaceId: "workspace-1",
      runId: "run-1",
      content: "Subject Alpha",
      dimension: "fact"
    });
    seedMemoryEntry(database, {
      objectId: "memory-d",
      workspaceId: "workspace-1",
      runId: "run-1",
      content: "Subject Beta",
      dimension: "fact"
    });

    seedRecallsPath(database, {
      pathId: "path-1",
      workspaceId: "workspace-1",
      sourceObjectId: "memory-a",
      targetObjectId: "memory-b"
    });
    seedRecallsPath(database, {
      pathId: "path-2",
      workspaceId: "workspace-1",
      sourceObjectId: "memory-b",
      targetObjectId: "memory-c"
    });

    seedEvidenceCapsule(database, {
      objectId: "evidence-1",
      workspaceId: "workspace-1",
      runId: "run-1",
      semanticAnchor: { subject: "alpha" }
    });
    seedEvidenceCapsule(database, {
      objectId: "evidence-2",
      workspaceId: "workspace-1",
      runId: "run-1",
      semanticAnchor: { subject: "alpha" }
    });
    seedSynthesisCapsule(database, {
      objectId: "synthesis-1",
      workspaceId: "workspace-1",
      runId: "run-1",
      topicKey: "alpha"
    });

    const mergeCandidates = await ports.mergePort.findMergeCandidates("workspace-1");
    expect(mergeCandidates.length).toBeGreaterThan(0);
    expect(mergeCandidates[0]?.duplicate_ids.length).toBeGreaterThan(0);
    expect(await ports.mergePort.hasPendingMergeProposal(mergeCandidates[0]!.primary_id)).toBe(false);
    const mergeProposal = await ports.mergePort.createMergeProposal("workspace-1", mergeCandidates[0]!);
    expect(mergeProposal.proposal_id).not.toHaveLength(0);
    expect(await ports.mergePort.hasPendingMergeProposal(mergeCandidates[0]!.primary_id)).toBe(true);

    const templateClusters = await ports.mergePort.findTemplateClusters("workspace-1", 3);
    expect(templateClusters.length).toBeGreaterThan(0);
    expect(await ports.mergePort.hasPendingTemplateProposal(templateClusters[0]!.representative_id)).toBe(false);
    const templateCandidate = await ports.mergePort.createTemplateCandidate("workspace-1", templateClusters[0]!);
    expect(templateCandidate.candidate_id).not.toHaveLength(0);
    expect(await ports.mergePort.hasPendingTemplateProposal(templateClusters[0]!.representative_id)).toBe(true);

    const neighbors = await ports.neighborPort.findSubjectNeighbors("workspace-1");
    expect(neighbors.some((group) => group.object_ids.length >= 2)).toBe(true);

    const compressible = await ports.compressionPort.findCompressiblePaths("workspace-1");
    expect(compressible).toEqual([
      {
        chain_start: "memory-a",
        chain_end: "memory-c",
        intermediate_ids: ["memory-b"]
      }
    ]);
    const compressionCandidate = await ports.compressionPort.createCompressionCandidate(
      "workspace-1",
      compressible[0]!
    );
    expect(compressionCandidate.candidate_id).not.toHaveLength(0);

    const clusters = await ports.synthesisPort.findSynthesisCandidateClusters("workspace-1");
    expect(clusters).toEqual([
      { subject: "alpha", evidence_ids: ["evidence-1", "evidence-2", "synthesis-1"] }
    ]);
    expect(await ports.synthesisPort.hasPendingSynthesisForSubject("workspace-1", "alpha")).toBe(false);
    const synthesisCandidate = await ports.synthesisPort.createSynthesisReviewCandidate("workspace-1", "alpha", [
      "evidence-1",
      "evidence-2"
    ]);
    expect(synthesisCandidate.candidate_id).not.toHaveLength(0);
    expect(await ports.synthesisPort.hasPendingSynthesisForSubject("workspace-1", "alpha")).toBe(true);
  });

  it("returns empty arrays gracefully for an empty database", async () => {
    const { ports } = await createFixture();

    expect(await ports.evidenceCheckPort.findMemoriesWithStaleEvidence("workspace-1")).toEqual([]);
    expect(await ports.pointerHealthPort.findBrokenPointers("workspace-1")).toEqual([]);
    expect(await ports.greenMaintenancePort.findExpiringGreenStatuses("workspace-1", 10_000)).toEqual([]);
    expect(await ports.bootstrappingPort.generateDraftCandidates("workspace-1")).toEqual([]);
    expect(await ports.bootstrappingPort.findHighFrequencyPatterns("workspace-1", 3)).toEqual([]);
    expect(await ports.tieringPort.findHotDemotionCandidates("workspace-1", {
      maxLastHitAgeMs: 10_000,
      minActivationScore: 0.5
    })).toEqual([]);
    expect(await ports.mergePort.findMergeCandidates("workspace-1")).toEqual([]);
    expect(await ports.neighborPort.findSubjectNeighbors("workspace-1")).toEqual([]);
    expect(await ports.compressionPort.findCompressiblePaths("workspace-1")).toEqual([]);
    expect(await ports.synthesisPort.findSynthesisCandidateClusters("workspace-1")).toEqual([]);
  });
});
