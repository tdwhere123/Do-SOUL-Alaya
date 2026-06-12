import { afterEach, describe, expect, it } from "vitest";
import { initDatabase, type StorageDatabase } from "../../sqlite/db.js";
import { createGardenBackgroundDataPorts } from "../../repos/garden/garden-data-ports.js";

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

describe("garden background data ports", () => {
  it("returns stale evidence refs and empty when refs are healthy", async () => {
    const { database, ports } = await createFixture();
    seedEvidenceCapsule(database, {
      objectId: "evidence-ok",
      workspaceId: "workspace-1",
      runId: "run-1",
      evidenceHealthState: "verified"
    });
    seedEvidenceCapsule(database, {
      objectId: "evidence-stale",
      workspaceId: "workspace-1",
      runId: "run-1",
      evidenceHealthState: "contested"
    });

    seedMemoryEntry(database, {
      objectId: "memory-stale",
      workspaceId: "workspace-1",
      runId: "run-1",
      evidenceRefs: ["evidence-ok", "missing-evidence", "evidence-stale"]
    });
    seedMemoryEntry(database, {
      objectId: "memory-fresh",
      workspaceId: "workspace-1",
      runId: "run-1",
      evidenceRefs: ["evidence-ok"]
    });

    const stale = await ports.evidenceCheckPort.findMemoriesWithStaleEvidence("workspace-1");
    expect(stale).toEqual([
      {
        memory_entry_id: "memory-stale",
        stale_evidence_refs: ["missing-evidence", "evidence-stale"]
      }
    ]);

    const freshOnly = await ports.evidenceCheckPort.findMemoriesWithStaleEvidence("workspace-2");
    expect(freshOnly).toEqual([]);
  });

  it("detects broken pointers across memory, claim, and synthesis references", async () => {
    const { database, ports } = await createFixture();
    seedEvidenceCapsule(database, {
      objectId: "evidence-ok",
      workspaceId: "workspace-1",
      runId: "run-1",
      evidenceHealthState: "verified"
    });

    seedMemoryEntry(database, {
      objectId: "memory-pointer",
      workspaceId: "workspace-1",
      runId: "run-1",
      evidenceRefs: ["evidence-ok", "evidence-missing"]
    });
    seedMemoryEntry(database, {
      objectId: "memory-ref-ok",
      workspaceId: "workspace-1",
      runId: "run-1"
    });
    seedSynthesisCapsule(database, {
      objectId: "synth-1",
      workspaceId: "workspace-1",
      runId: "run-1",
      evidenceRefs: ["evidence-missing-2"],
      sourceMemoryRefs: ["memory-ref-ok", "memory-ref-missing"]
    });
    seedClaimForm(database, {
      objectId: "claim-1",
      workspaceId: "workspace-1",
      evidenceRefs: ["evidence-missing-3"],
      sourceObjectRefs: ["memory-ref-ok", "synth-1", "memory-ref-missing-2", "synth-missing"]
    });

    const broken = await ports.pointerHealthPort.findBrokenPointers("workspace-1");
    expect(broken).toEqual(
      expect.arrayContaining([
        {
          source_object_id: "memory-pointer",
          source_object_kind: "memory_entry",
          broken_ref: "evidence-missing",
          ref_kind: "evidence_ref"
        },
        {
          source_object_id: "synth-1",
          source_object_kind: "synthesis_capsule",
          broken_ref: "evidence-missing-2",
          ref_kind: "evidence_ref"
        },
        {
          source_object_id: "synth-1",
          source_object_kind: "synthesis_capsule",
          broken_ref: "memory-ref-missing",
          ref_kind: "memory_ref"
        },
        {
          source_object_id: "claim-1",
          source_object_kind: "claim_form",
          broken_ref: "evidence-missing-3",
          ref_kind: "evidence_ref"
        },
        {
          source_object_id: "claim-1",
          source_object_kind: "claim_form",
          broken_ref: "memory-ref-missing-2",
          ref_kind: "source_object_ref"
        },
        {
          source_object_id: "claim-1",
          source_object_kind: "claim_form",
          broken_ref: "synth-missing",
          ref_kind: "source_object_ref"
        }
      ])
    );
    expect(broken).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_object_id: "claim-1",
          broken_ref: "memory-ref-ok"
        }),
        expect.objectContaining({
          source_object_id: "claim-1",
          broken_ref: "synth-1"
        })
      ])
    );
  });

  it("supports green maintenance queries and transitions", async () => {
    const { database, ports } = await createFixture();
    seedMemoryEntry(database, {
      objectId: "memory-green",
      workspaceId: "workspace-1",
      runId: "run-1",
      dimension: "fact"
    });
    seedMemoryEntry(database, {
      objectId: "memory-revoke",
      workspaceId: "workspace-1",
      runId: "run-1",
      dimension: "constraint"
    });

    seedGreenStatus(database, {
      objectId: "green-expiring",
      workspaceId: "workspace-1",
      targetObjectId: "memory-green",
      verificationBasis: "passive_stable",
      greenState: "eligible",
      validUntil: "2026-04-20T00:00:00.000Z"
    });
    seedGreenStatus(database, {
      objectId: "green-revoke",
      workspaceId: "workspace-1",
      targetObjectId: "memory-revoke",
      verificationBasis: "active_verification",
      greenState: "eligible",
      validUntil: "2026-04-20T00:00:00.000Z"
    });

    const expiring = await ports.greenMaintenancePort.findExpiringGreenStatuses(
      "workspace-1",
      10 * 24 * 60 * 60 * 1000
    );
    expect(expiring).toEqual([
      {
        green_status_id: "green-expiring",
        memory_entry_id: "memory-green",
        dimension: "fact",
        valid_until: "2026-04-20T00:00:00.000Z"
      },
      {
        green_status_id: "green-revoke",
        memory_entry_id: "memory-revoke",
        dimension: "constraint",
        valid_until: "2026-04-20T00:00:00.000Z"
      }
    ]);

    await ports.greenMaintenancePort.renewGreenPassiveStable("green-expiring", "task-1");
    await ports.greenMaintenancePort.requestActiveVerification("green-expiring", "task-2");
    const revokeResult = ports.greenMaintenancePort.revokeGreen(
      "memory-revoke",
      "verification_fail",
      "task-3",
      "workspace-1"
    );
    expect(revokeResult).toEqual({ affected: 1 });

    const noopResult = ports.greenMaintenancePort.revokeGreen(
      "memory-revoke",
      "verification_fail",
      "task-3",
      "workspace-1"
    );
    expect(noopResult).toEqual({ affected: 0 });

    const crossWorkspaceNoop = ports.greenMaintenancePort.revokeGreen(
      "memory-revoke",
      "verification_fail",
      "task-3",
      "workspace-other"
    );
    expect(crossWorkspaceNoop).toEqual({ affected: 0 });

    const greenRow = database.connection
      .prepare(
        "SELECT green_state, verification_basis, revoke_reason FROM green_statuses WHERE object_id = ? LIMIT 1"
      )
      .get("green-expiring") as
      | { readonly green_state: string; readonly verification_basis: string; readonly revoke_reason: string }
      | undefined;
    expect(greenRow).toEqual({
      green_state: "grace",
      verification_basis: "active_verification",
      revoke_reason: "none"
    });

    const revokedRow = database.connection
      .prepare("SELECT green_state, revoke_reason FROM green_statuses WHERE object_id = ? LIMIT 1")
      .get("green-revoke") as { readonly green_state: string; readonly revoke_reason: string } | undefined;
    expect(revokedRow).toEqual({
      green_state: "revoked",
      revoke_reason: "verification_fail"
    });
  });

  it("revokeGreenOnEvidenceRewrite sets revoke_reason='mapping_revoked' when new evidence_refs share zero overlap", async () => {
    const { database, ports } = await createFixture();
    seedMemoryEntry(database, {
      objectId: "memory-reanchored",
      workspaceId: "workspace-1",
      runId: "run-1",
      evidenceRefs: ["evidence-original-a", "evidence-original-b"]
    });
    seedGreenStatus(database, {
      objectId: "green-reanchored",
      workspaceId: "workspace-1",
      targetObjectId: "memory-reanchored",
      verificationBasis: "active_verification",
      greenState: "eligible",
      validUntil: "2026-05-15T00:00:00.000Z"
    });

    const overlapResult = ports.greenMaintenancePort.revokeGreenOnEvidenceRewrite({
      memoryEntryId: "memory-reanchored",
      workspaceId: "workspace-1",
      newEvidenceRefs: ["evidence-original-a", "evidence-new"]
    });
    expect(overlapResult).toEqual({ affected: 0 });

    const overlapRow = database.connection
      .prepare("SELECT green_state, revoke_reason FROM green_statuses WHERE object_id = ? LIMIT 1")
      .get("green-reanchored") as { readonly green_state: string; readonly revoke_reason: string } | undefined;
    expect(overlapRow).toEqual({ green_state: "eligible", revoke_reason: "none" });

    const rewriteResult = ports.greenMaintenancePort.revokeGreenOnEvidenceRewrite({
      memoryEntryId: "memory-reanchored",
      workspaceId: "workspace-1",
      newEvidenceRefs: ["evidence-new-1", "evidence-new-2"]
    });
    expect(rewriteResult).toEqual({ affected: 1 });

    const revokedRow = database.connection
      .prepare("SELECT green_state, revoke_reason FROM green_statuses WHERE object_id = ? LIMIT 1")
      .get("green-reanchored") as { readonly green_state: string; readonly revoke_reason: string } | undefined;
    expect(revokedRow).toEqual({ green_state: "revoked", revoke_reason: "mapping_revoked" });
  });

  it("revokeGreenOnEvidenceRewrite is a no-op when the memory entry does not exist", async () => {
    const { ports } = await createFixture();
    const result = ports.greenMaintenancePort.revokeGreenOnEvidenceRewrite({
      memoryEntryId: "memory-missing",
      workspaceId: "workspace-1",
      newEvidenceRefs: ["evidence-new"]
    });
    expect(result).toEqual({ affected: 0 });
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

async function createFixture(): Promise<{
  readonly database: StorageDatabase;
  readonly ports: ReturnType<typeof createGardenBackgroundDataPorts>;
}> {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  seedWorkspace(database, { workspaceId: "workspace-1" });
  seedWorkspace(database, { workspaceId: "workspace-2" });
  seedRun(database, { workspaceId: "workspace-1", runId: "run-1" });
  seedRun(database, { workspaceId: "workspace-2", runId: "run-2" });

  return {
    database,
    ports: createGardenBackgroundDataPorts(database, {
      now: () => "2026-04-15T00:00:00.000Z"
    })
  };
}

function seedWorkspace(
  database: StorageDatabase,
  params: {
    readonly workspaceId: string;
  }
): void {
  database.connection
    .prepare(
      `INSERT INTO workspaces (
        workspace_id,
        name,
        root_path,
        workspace_kind,
        default_engine_binding,
        workspace_state,
        created_at,
        archived_at,
        default_engine_class
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      params.workspaceId,
      `${params.workspaceId} name`,
      `/tmp/${params.workspaceId}`,
      "local_repo",
      null,
      "active",
      "2026-04-15T00:00:00.000Z",
      null,
      null
    );
}

function seedRun(
  database: StorageDatabase,
  params: {
    readonly workspaceId: string;
    readonly runId: string;
  }
): void {
  database.connection
    .prepare(
      `INSERT INTO runs (
        run_id,
        workspace_id,
        title,
        goal,
        run_mode,
        engine_binding_id,
        run_state,
        current_surface_id,
        created_at,
        last_active_at,
        engine_class
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      params.runId,
      params.workspaceId,
      `${params.runId} title`,
      null,
      "chat",
      null,
      "idle",
      null,
      "2026-04-15T00:00:00.000Z",
      "2026-04-15T00:00:00.000Z",
      null
    );
}

function seedMemoryEntry(
  database: StorageDatabase,
  params: {
    readonly objectId: string;
    readonly workspaceId: string;
    readonly runId: string;
    readonly dimension?: string;
    readonly content?: string;
    readonly evidenceRefs?: readonly string[];
    readonly activationScore?: number;
    readonly lastHitAt?: string | null;
    readonly lifecycleState?: string;
    readonly storageTier?: string;
  }
): void {
  database.connection
    .prepare(
      `INSERT INTO memory_entries (
        object_id,
        object_kind,
        schema_version,
        lifecycle_state,
        created_at,
        updated_at,
        created_by,
        dimension,
        source_kind,
        formation_kind,
        scope_class,
        content,
        domain_tags,
        evidence_refs,
        workspace_id,
        run_id,
        surface_id,
        storage_tier,
        activation_score,
        retention_score,
        manifestation_state,
        retention_state,
        decay_profile,
        confidence,
        last_used_at,
        last_hit_at,
        reinforcement_count,
        contradiction_count,
        superseded_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      params.objectId,
      "memory_entry",
      1,
      params.lifecycleState ?? "active",
      "2026-04-15T00:00:00.000Z",
      "2026-04-15T00:00:00.000Z",
      "user",
      params.dimension ?? "fact",
      "user",
      "explicit",
      "project",
      params.content ?? params.objectId,
      "[]",
      JSON.stringify(params.evidenceRefs ?? []),
      params.workspaceId,
      params.runId,
      null,
      params.storageTier ?? "hot",
      params.activationScore ?? 0.5,
      0.5,
      "hint",
      "working",
      "normal",
      0.5,
      null,
      params.lastHitAt ?? "2026-04-15T00:00:00.000Z",
      0,
      0,
      null
    );
}

function seedEvidenceCapsule(
  database: StorageDatabase,
  params: {
    readonly objectId: string;
    readonly workspaceId: string;
    readonly runId: string;
    readonly evidenceHealthState?: string;
    readonly semanticAnchor?: Record<string, unknown>;
  }
): void {
  database.connection
    .prepare(
      `INSERT INTO evidence_capsules (
        object_id,
        object_kind,
        schema_version,
        lifecycle_state,
        created_at,
        updated_at,
        created_by,
        evidence_kind,
        semantic_anchor,
        event_anchor,
        physical_anchor,
        evidence_health_state,
        gist,
        excerpt,
        source_hash,
        run_id,
        workspace_id,
        surface_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      params.objectId,
      "evidence_capsule",
      1,
      "active",
      "2026-04-15T00:00:00.000Z",
      "2026-04-15T00:00:00.000Z",
      "user",
      "observation",
      JSON.stringify(params.semanticAnchor ?? { subject: params.objectId }),
      null,
      null,
      params.evidenceHealthState ?? "verified",
      params.objectId,
      null,
      null,
      params.runId,
      params.workspaceId,
      null
    );
}

function seedSynthesisCapsule(
  database: StorageDatabase,
  params: {
    readonly objectId: string;
    readonly workspaceId: string;
    readonly runId: string;
    readonly topicKey?: string;
    readonly evidenceRefs?: readonly string[];
    readonly sourceMemoryRefs?: readonly string[];
  }
): void {
  database.connection
    .prepare(
      `INSERT INTO synthesis_capsules (
        object_id,
        object_kind,
        schema_version,
        lifecycle_state,
        created_at,
        updated_at,
        created_by,
        topic_key,
        synthesis_type,
        summary,
        evidence_refs,
        source_memory_refs,
        workspace_id,
        run_id,
        synthesis_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      params.objectId,
      "synthesis_capsule",
      1,
      "active",
      "2026-04-15T00:00:00.000Z",
      "2026-04-15T00:00:00.000Z",
      "user",
      params.topicKey ?? `${params.objectId}.topic`,
      "phase_synthesis",
      params.objectId,
      JSON.stringify(params.evidenceRefs ?? []),
      JSON.stringify(params.sourceMemoryRefs ?? []),
      params.workspaceId,
      params.runId,
      "working"
    );
}

function seedClaimForm(
  database: StorageDatabase,
  params: {
    readonly objectId: string;
    readonly workspaceId: string;
    readonly evidenceRefs: readonly string[];
    readonly sourceObjectRefs: readonly string[];
    readonly canonicalKey?: string;
    readonly lifecycleState?: string;
    readonly claimStatus?: string;
  }
): void {
  database.connection
    .prepare(
      `INSERT INTO claim_forms (
        object_id,
        object_kind,
        schema_version,
        lifecycle_state,
        created_at,
        updated_at,
        created_by,
        governance_subject,
        claim_kind,
        scope_class,
        enforcement_level,
        origin_tier,
        precedence_basis,
        proposition_digest,
        evidence_refs,
        source_object_refs,
        workspace_id,
        claim_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      params.objectId,
      "claim_form",
      1,
      params.lifecycleState ?? "active",
      "2026-04-15T00:00:00.000Z",
      "2026-04-15T00:00:00.000Z",
      "user",
      JSON.stringify({ canonical_key: params.canonicalKey ?? params.objectId }),
      "constraint",
      "project",
      "strict",
      "user_explicit",
      "authority",
      params.objectId,
      JSON.stringify(params.evidenceRefs),
      JSON.stringify(params.sourceObjectRefs),
      params.workspaceId,
      params.claimStatus ?? "draft"
    );
}

function seedGreenStatus(
  database: StorageDatabase,
  params: {
    readonly objectId: string;
    readonly workspaceId: string;
    readonly targetObjectId: string;
    readonly verificationBasis?: string;
    readonly greenState?: string;
    readonly validUntil: string | null;
  }
): void {
  database.connection
    .prepare(
      `INSERT INTO green_statuses (
        object_id,
        object_kind,
        schema_version,
        lifecycle_state,
        created_at,
        updated_at,
        created_by,
        target_object_id,
        target_object_kind,
        green_state,
        verification_basis,
        verified_by,
        verified_at,
        valid_until,
        bound_surfaces,
        bound_scope_class,
        revoke_reason,
        last_transition_at,
        workspace_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      params.objectId,
      "green_status",
      1,
      "active",
      "2026-04-15T00:00:00.000Z",
      "2026-04-15T00:00:00.000Z",
      "system",
      params.targetObjectId,
      "memory_entry",
      params.greenState ?? "eligible",
      params.verificationBasis ?? "active_verification",
      "auditor",
      "2026-04-15T00:00:00.000Z",
      params.validUntil,
      "[]",
      "project",
      "none",
      "2026-04-15T00:00:00.000Z",
      params.workspaceId
    );
}

function seedRecallsPath(
  database: StorageDatabase,
  params: {
    readonly pathId: string;
    readonly workspaceId: string;
    readonly sourceObjectId: string;
    readonly targetObjectId: string;
  }
): void {
  database.connection
    .prepare(
      `INSERT INTO path_relations (
        path_id,
        workspace_id,
        anchors_json,
        constitution_json,
        effect_vector_json,
        plasticity_state_json,
        lifecycle_json,
        legitimacy_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      params.pathId,
      params.workspaceId,
      JSON.stringify({
        source_anchor: { kind: "object", object_id: params.sourceObjectId },
        target_anchor: { kind: "object", object_id: params.targetObjectId }
      }),
      JSON.stringify({
        relation_kind: "recalls",
        why_this_relation_exists: ["co_recall"]
      }),
      JSON.stringify({
        salience: 0.3,
        recall_bias: 0.3,
        verification_bias: 0,
        unfinishedness_bias: 0,
        default_manifestation_preference: "stance_bias"
      }),
      JSON.stringify({
        strength: 0.3,
        direction_bias: "source_to_target",
        stability_class: "volatile",
        support_events_count: 1,
        contradiction_events_count: 0
      }),
      JSON.stringify({
        status: "active",
        retirement_rule: "retire_after_cooldown"
      }),
      JSON.stringify({
        evidence_basis: ["evidence-1"],
        governance_class: "hint_only"
      }),
      "2026-04-15T00:00:00.000Z",
      "2026-04-15T00:00:00.000Z"
    );
}
