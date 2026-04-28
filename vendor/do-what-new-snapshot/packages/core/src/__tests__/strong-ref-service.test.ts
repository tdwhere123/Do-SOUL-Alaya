import { describe, expect, it, vi } from "vitest";
import type { StrongRef } from "@do-what/protocol";
import { StrongRefService } from "../strong-ref-service.js";

describe("StrongRefService", () => {
  it("protect() persists a strong ref and keeps it protected until release()", async () => {
    const repo = createRepoDouble();
    const service = new StrongRefService({
      repo,
      generateRefId: () => "strong-ref-1",
      now: () => "2026-04-15T00:00:00.000Z"
    });

    const protectedRef = await service.protect({
      sourceEntityType: "governance_lease",
      sourceEntityId: "lease-1",
      targetEntityType: "claim_form",
      targetEntityId: "claim-1",
      workspaceId: "workspace-1",
      reason: "governance_lease"
    });

    expect(protectedRef).toEqual(createStrongRefFixture());
    await expect(service.isProtected("workspace-1", "claim_form", "claim-1")).resolves.toBe(true);
    await expect(service.areAllProtected("workspace-1", "claim_form", ["claim-1"])).resolves.toBe(true);

    await service.release("strong-ref-1");

    await expect(service.isProtected("workspace-1", "claim_form", "claim-1")).resolves.toBe(false);
    await expect(service.areAllProtected("workspace-1", "claim_form", ["claim-1"])).resolves.toBe(false);
  });

  it("protect() is idempotent for the same source/target/reason tuple", async () => {
    const existing = createStrongRefFixture({
      ref_id: "strong-ref-existing",
      source_entity_type: "run",
      source_entity_id: "run-1",
      reason: "governance_lease"
    });
    const repo = createRepoDouble([existing]);
    const service = new StrongRefService({
      repo,
      generateRefId: () => "strong-ref-new",
      now: () => "2026-04-15T00:00:00.000Z"
    });

    const protectedRef = await service.protect({
      sourceEntityType: "run",
      sourceEntityId: "run-1",
      targetEntityType: "claim_form",
      targetEntityId: "claim-1",
      workspaceId: "workspace-1",
      reason: "governance_lease"
    });

    expect(protectedRef).toEqual(existing);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it("protect() returns the existing ref after a concurrent create conflict", async () => {
    const existing = createStrongRefFixture({
      ref_id: "strong-ref-existing",
      source_entity_type: "run",
      source_entity_id: "run-1",
      reason: "governance_lease"
    });
    const repo = createRepoDouble();
    repo.create.mockRejectedValueOnce(new Error("unique conflict"));
    repo.findBySource
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([existing]);
    const service = new StrongRefService({
      repo,
      generateRefId: () => "strong-ref-new",
      now: () => "2026-04-15T00:00:00.000Z"
    });

    const protectedRef = await service.protect({
      sourceEntityType: "run",
      sourceEntityId: "run-1",
      targetEntityType: "claim_form",
      targetEntityId: "claim-1",
      workspaceId: "workspace-1",
      reason: "governance_lease"
    });

    expect(protectedRef).toEqual(existing);
    expect(repo.create).toHaveBeenCalledTimes(1);
    expect(repo.findBySource).toHaveBeenCalledTimes(2);
  });

  it("findByTargets delegates to repo lookup", async () => {
    const repo = createRepoDouble([
      createStrongRefFixture(),
      createStrongRefFixture({
        ref_id: "strong-ref-2",
        target_entity_id: "claim-2"
      })
    ]);
    const service = new StrongRefService({
      repo,
      generateRefId: () => "strong-ref-3",
      now: () => "2026-04-15T00:00:00.000Z"
    });

    const refs = await service.findByTargets("workspace-1", "claim_form", ["claim-1", "claim-2"]);

    expect(refs).toEqual([
      createStrongRefFixture(),
      createStrongRefFixture({
        ref_id: "strong-ref-2",
        target_entity_id: "claim-2"
      })
    ]);
    expect(repo.findByTargets).toHaveBeenCalledWith("workspace-1", "claim_form", ["claim-1", "claim-2"]);
  });

  it("releaseBySource delegates source-scoped cleanup to repo", async () => {
    const repo = createRepoDouble([
      createStrongRefFixture({
        source_entity_type: "worker_run",
        source_entity_id: "worker-1"
      }),
      createStrongRefFixture({
        ref_id: "strong-ref-2",
        source_entity_type: "worker_run",
        source_entity_id: "worker-1",
        target_entity_id: "claim-2"
      })
    ]);
    const service = new StrongRefService({
      repo,
      generateRefId: () => "strong-ref-3",
      now: () => "2026-04-15T00:00:00.000Z"
    });

    await service.releaseBySource({
      sourceEntityType: "worker_run",
      sourceEntityId: "worker-1"
    });

    expect(repo.deleteBySource).toHaveBeenCalledWith("worker_run", "worker-1");
  });
});

function createRepoDouble(initialRefs: readonly StrongRef[] = []) {
  const refs = new Map<string, StrongRef>(initialRefs.map((ref) => [ref.ref_id, ref]));
  const create = vi.fn(async (ref: StrongRef) => {
    refs.set(ref.ref_id, ref);
    return ref;
  });
  const deleteById = vi.fn(async (refId: string) => {
    refs.delete(refId);
  });
  const deleteBySource = vi.fn(async (sourceEntityType: string, sourceEntityId: string) => {
    for (const [refId, ref] of refs.entries()) {
      if (ref.source_entity_type === sourceEntityType && ref.source_entity_id === sourceEntityId) {
        refs.delete(refId);
      }
    }
  });
  const findByTarget = vi.fn(async (workspaceId: string, targetEntityType: string, targetEntityId: string) =>
    [...refs.values()].filter((ref) => ref.workspace_id === workspaceId && ref.target_entity_type === targetEntityType && ref.target_entity_id === targetEntityId)
  );
  const findByTargets = vi.fn(async (workspaceId: string, targetEntityType: string, targetEntityIds: readonly string[]) =>
    [...refs.values()].filter((ref) => ref.workspace_id === workspaceId && ref.target_entity_type === targetEntityType && targetEntityIds.includes(ref.target_entity_id))
  );
  const findBySource = vi.fn(async (sourceEntityId: string) =>
    [...refs.values()].filter((ref) => ref.source_entity_id === sourceEntityId)
  );
  const isProtected = vi.fn(async (workspaceId: string, targetEntityType: string, targetEntityId: string) =>
    [...refs.values()].some((ref) => ref.workspace_id === workspaceId && ref.target_entity_type === targetEntityType && ref.target_entity_id === targetEntityId)
  );
  const areAllProtected = vi.fn(async (workspaceId: string, targetEntityType: string, targetEntityIds: readonly string[]) =>
    targetEntityIds.every((targetEntityId) => [...refs.values()].some((ref) => ref.workspace_id === workspaceId && ref.target_entity_type === targetEntityType && ref.target_entity_id === targetEntityId))
  );

  return {
    create,
    delete: deleteById,
    deleteBySource,
    findByTarget,
    findByTargets,
    findBySource,
    isProtected,
    areAllProtected
  };
}

function createStrongRefFixture(overrides: Partial<StrongRef> = {}): StrongRef {
  return {
    ref_id: "strong-ref-1",
    source_entity_type: "governance_lease",
    source_entity_id: "lease-1",
    target_entity_type: "claim_form",
    target_entity_id: "claim-1",
    workspace_id: "workspace-1",
    reason: "governance_lease",
    created_at: "2026-04-15T00:00:00.000Z",
    ...overrides
  };
}
