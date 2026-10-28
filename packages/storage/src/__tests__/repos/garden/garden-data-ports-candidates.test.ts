import { afterEach, describe, expect, it } from "vitest";
import {
  createFixture,
  seedClaimForm,
  seedEvidenceCapsule,
  seedMemoryEntry,
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
  it("finds a later eligible pattern beyond the pending prefix in the same workspace", async () => {
    const { database, ports } = await createFixture();
    const insertPending = database.connection.prepare(`INSERT INTO proposals
      (runtime_id, proposal_id, derived_from, dossier_ref, resolution_state, last_updated_at, workspace_id)
      VALUES (?, ?, ?, 'bootstrapping.synthesis_candidate', 'pending', '2026-04-15T00:00:00.000Z', ?)`);
    for (let index = 0; index <= 120; index++) {
      const pattern = `pattern-${String(index).padStart(3, "0")}`;
      for (let occurrence = 0; occurrence < 3; occurrence++) seedMemoryEntry(database, {
        objectId: `memory-${index}-${occurrence}`, workspaceId: "workspace-1", runId: "run-1", content: pattern
      });
      if (index < 120) insertPending.run(`runtime-${index}`, `proposal-${index}`, `bootstrapping:memory:${pattern}`, "workspace-1");
    }
    insertPending.run("foreign-runtime", "foreign-proposal", "bootstrapping:memory:pattern-120", "workspace-2");
    expect(await ports.bootstrappingPort.findHighFrequencyPatterns("workspace-1", 3)).toEqual([
      { pattern_key: "memory:pattern-120", frequency: 3 }
    ]);
  });

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

    expect(ports.tieringPort.demoteToWarm("workspace-1", ["memory-demote"])).toEqual(["memory-demote"]);
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

  it("hot demotion returns only ids that actually left the hot tier", async () => {
    const { database, ports } = await createFixture();
    seedMemoryEntry(database, {
      objectId: "memory-hot",
      workspaceId: "workspace-1",
      runId: "run-1",
      activationScore: 0.1,
      lastHitAt: "2026-01-01T00:00:00.000Z"
    });
    seedMemoryEntry(database, {
      objectId: "memory-already-cold",
      workspaceId: "workspace-1",
      runId: "run-1",
      activationScore: 0.1,
      lastHitAt: "2026-01-01T00:00:00.000Z",
      storageTier: "cold"
    });
    seedMemoryEntry(database, {
      objectId: "memory-retired",
      workspaceId: "workspace-1",
      runId: "run-1",
      activationScore: 0.1,
      lastHitAt: "2026-01-01T00:00:00.000Z",
      lifecycleState: "archived"
    });

    expect(
      ports.tieringPort.demoteToWarm("workspace-1", [
        "memory-hot",
        "memory-already-cold",
        "memory-retired"
      ])
    ).toEqual(["memory-hot"]);

    const tiers = database.connection
      .prepare(
        "SELECT object_id, storage_tier, lifecycle_state FROM memory_entries WHERE object_id IN (?, ?, ?) ORDER BY object_id"
      )
      .all("memory-already-cold", "memory-hot", "memory-retired") as readonly {
        readonly object_id: string;
        readonly storage_tier: string;
        readonly lifecycle_state: string;
      }[];
    expect(tiers).toEqual([
      { object_id: "memory-already-cold", storage_tier: "cold", lifecycle_state: "active" },
      { object_id: "memory-hot", storage_tier: "cold", lifecycle_state: "active" },
      { object_id: "memory-retired", storage_tier: "hot", lifecycle_state: "archived" }
    ]);
  });

  it("finds Librarian neighbors and synthesizes evidence without treating prior synthesis as evidence", async () => {
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

    const neighbors = await ports.neighborPort.findSubjectNeighbors("workspace-1");
    expect(neighbors.some((group) => group.object_ids.length >= 2)).toBe(true);

    const clusters = await ports.synthesisPort.findSynthesisCandidateClusters("workspace-1");
    expect(clusters).toEqual([
      { subject: "alpha", evidence_ids: ["evidence-1", "evidence-2"] }
    ]);
    expect(await ports.synthesisPort.hasPendingSynthesisForSubject("workspace-1", "alpha")).toBe(false);
    const synthesisCandidate = await ports.synthesisPort.createSynthesisReviewCandidate("workspace-1", "alpha", [
      "evidence-1",
      "evidence-2"
    ]);
    expect(synthesisCandidate.candidate_id).not.toHaveLength(0);
    expect(await ports.synthesisPort.hasPendingSynthesisForSubject("workspace-1", "alpha")).toBe(true);
  });

  it("finds a later synthesis subject after more than a scan page of pending subjects", async () => {
    const { database, ports } = await createFixture();
    for (let index = 0; index <= 80; index += 1) {
      const subject = `subject-${String(index).padStart(3, "0")}`;
      const evidenceIds = [`evidence-${index}-a`, `evidence-${index}-b`];
      for (const objectId of evidenceIds) seedEvidenceCapsule(database, {
        objectId, workspaceId: "workspace-1", runId: "run-1", semanticAnchor: { subject }
      });
      if (index < 80) await ports.synthesisPort.createSynthesisReviewCandidate("workspace-1", subject, evidenceIds);
    }
    const remaining = await ports.synthesisPort.findSynthesisCandidateClusters("workspace-1");
    expect(remaining).toEqual([{ subject: "subject-080", evidence_ids: ["evidence-80-a", "evidence-80-b"] }]);
  });

  it("does not let a pending synthesis subject in one workspace hide another", async () => {
    const { database, ports } = await createFixture();
    for (const [workspaceId, runId] of [["workspace-1", "run-1"], ["workspace-2", "run-2"]] as const) {
      for (const suffix of ["a", "b"]) seedEvidenceCapsule(database, {
        objectId: `${workspaceId}-${suffix}`, workspaceId, runId, semanticAnchor: { subject: "shared" }
      });
    }
    await ports.synthesisPort.createSynthesisReviewCandidate("workspace-1", "shared", ["workspace-1-a", "workspace-1-b"]);
    expect(await ports.synthesisPort.findSynthesisCandidateClusters("workspace-1")).toEqual([]);
    expect(await ports.synthesisPort.hasPendingSynthesisForSubject("workspace-2", "shared")).toBe(false);
    expect(await ports.synthesisPort.findSynthesisCandidateClusters("workspace-2")).toEqual([
      { subject: "shared", evidence_ids: ["workspace-2-a", "workspace-2-b"] }
    ]);
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
    expect(await ports.neighborPort.findSubjectNeighbors("workspace-1")).toEqual([]);
    expect(await ports.synthesisPort.findSynthesisCandidateClusters("workspace-1")).toEqual([]);
  });
});
