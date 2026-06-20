import { afterEach, describe, expect, it } from "vitest";
import {
  createFixture,
  seedClaimForm,
  seedEvidenceCapsule,
  seedGreenStatus,
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

});
