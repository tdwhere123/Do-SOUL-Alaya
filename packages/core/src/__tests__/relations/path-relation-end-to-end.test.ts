import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryDimension } from "@do-soul/alaya-protocol";
import { SqliteCoUsageCounterRepo, SqlitePathRelationRepo, type StorageDatabase } from "@do-soul/alaya-storage";
import { PathRelationProposalService, CO_RECALLED_SEED_PROFILE } from "../../relations/edge-proposals/path-relation-proposal-service.js";
import { EventPublisher } from "../../runtime/event-publisher.js";
import { createSourceBoundRecallFixture, createTaskSurface, createPathRelation } from "../recall/recall-service-test-fixtures.js";
import { MEM, WS, NOW, openSourceSlice } from "../recall/conditional-field/vertical/source-slice.js";

const databases = new Set<StorageDatabase>();
afterEach(() => { for (const database of databases) database.close(); databases.clear(); });

function proposalOwner(slice: Awaited<ReturnType<typeof openSourceSlice>>) {
  const pathRelationRepo = new SqlitePathRelationRepo(slice.database);
  const eventPublisher = new EventPublisher({ eventLogRepo: slice.storage.eventLogRepo,
    runHotStateService: { apply: () => {} }, runtimeNotifier: { notify: async () => {}, notifyEntry: async () => {} } });
  const service = new PathRelationProposalService({
    repo: { create: (path) => pathRelationRepo.create(path),
      findByAnchorMemoryId: (memoryId, workspaceId) => pathRelationRepo.findByAnchors(workspaceId, [{ kind: "object", object_id: memoryId }]) },
    counterStore: new SqliteCoUsageCounterRepo(slice.database), eventPublisher,
    generateId: () => "33333333-3333-4333-8333-aaaaaaaaaaaa", now: () => NOW
  });
  return { pathRelationRepo, service };
}

const candidate = {
  workspaceId: WS, sourceAnchor: { kind: "object" as const, object_id: MEM.r }, targetAnchor: { kind: "object" as const, object_id: MEM.l },
  relationKind: CO_RECALLED_SEED_PROFILE.relationKind, initialStrength: CO_RECALLED_SEED_PROFILE.initialStrength,
  governanceClass: CO_RECALLED_SEED_PROFILE.governanceClass, evidenceBasis: CO_RECALLED_SEED_PROFILE.evidenceBasis,
  recallBiasSign: CO_RECALLED_SEED_PROFILE.recallBiasSign, recallBiasMagnitude: CO_RECALLED_SEED_PROFILE.recallBiasMagnitude
};

describe("retained path proposals and conditional source authority", () => {
  it("persists a submitted co-usage path without minting a source-grounded association", async () => {
    const f = await createSourceBoundRecallFixture((database) => databases.add(database));
    await f.writeMemory(MEM.r, "Atlas deployment command", MemoryDimension.FACT);
    await f.writeMemory(MEM.l, "unrelated picnic recipe", MemoryDimension.FACT);
    const owner = proposalOwner(f);
    expect(await owner.service.submitCandidate(candidate)).toBe("applied");
    const paths = await owner.pathRelationRepo.findByAnchors(WS, [candidate.sourceAnchor]);
    expect(paths).toHaveLength(1);
    expect(paths[0]?.anchors).toEqual({ source_anchor: candidate.sourceAnchor, target_anchor: candidate.targetAnchor });
    const result = await f.service.recall({ taskSurface: { ...createTaskSurface(), display_name: "Atlas deployment" }, workspaceId: WS, strategy: "build" });
    expect(result.candidates.map((row) => row.object_id)).toEqual([MEM.r]);
    expect(result.index?.entries.some((row) => row.object_id === MEM.l)).toBe(false);
  });

  it("retains a time-concern routing anchor without substituting it for observed source time", async () => {
    const f = await createSourceBoundRecallFixture((database) => databases.add(database));
    await f.writeMemory(MEM.r, "Atlas deployment checkpoint", MemoryDimension.FACT);
    const repo = new SqlitePathRelationRepo(f.database);
    repo.create({ ...createPathRelation({ path_id: "time-routing", sourceId: MEM.r, targetId: MEM.r }),
      anchors: { source_anchor: candidate.sourceAnchor, target_anchor: { kind: "time_concern", source_object_id: MEM.r, window_digest: "yesterday" } } });
    expect((await repo.findByAnchors(WS, [candidate.sourceAnchor]))[0]?.anchors.target_anchor)
      .toMatchObject({ kind: "time_concern", window_digest: "yesterday" });
    expect((await f.memoryEntryRepo.findById(MEM.r))?.event_time_start ?? null).toBeNull();
    const result = await f.service.recall({ taskSurface: { ...createTaskSurface(), display_name: "Atlas deployment" }, workspaceId: WS, strategy: "build" });
    expect(result.candidates.map((row) => row.object_id)).toEqual([MEM.r]);
  });

  it("keeps proposal identity and duplicate admission after close and reopen", async () => {
    const directory = mkdtempSync(join(tmpdir(), "alaya-path-history-"));
    const filename = join(directory, "source.sqlite");
    try {
      const first = await openSourceSlice((database) => databases.add(database), filename);
      expect(await proposalOwner(first).service.submitCandidate(candidate)).toBe("applied");
      first.database.close(); databases.delete(first.database);
      const second = await openSourceSlice((database) => databases.add(database), filename);
      const owner = proposalOwner(second);
      expect(await owner.pathRelationRepo.findByAnchors(WS, [candidate.sourceAnchor])).toHaveLength(1);
      expect(await owner.service.submitCandidate(candidate)).toBe("already_present");
      expect(await owner.pathRelationRepo.findByAnchors(WS, [candidate.sourceAnchor])).toHaveLength(1);
      second.database.close(); databases.delete(second.database);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
