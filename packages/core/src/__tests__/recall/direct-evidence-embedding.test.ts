import { MemoryDimension, type EvidenceCapsule } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecallService } from "../../recall/recall-service.js";
import { createSourceBoundRecallFixture, createTaskSurface } from "./recall-service-test-fixtures.js";

const databases = new Set<StorageDatabase>();
afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});
const MEMORY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-000000000291";
const EVIDENCE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-000000000292";
const NOW = "2026-09-06T12:00:00.000Z";

describe("evidence storage and conditional Recall without transient embedding", () => {
  it.each([true, false])("keeps source delivery with optional legacy scoring capability=%s", async (withScoring) => {
    const fixture = await createSourceBoundRecallFixture((database) => databases.add(database));
    await fixture.writeMemory(MEMORY_ID, "The assistant recommended blue.", MemoryDimension.FACT);
    const capsule: EvidenceCapsule = {
      object_id: EVIDENCE_ID, object_kind: "evidence_capsule", schema_version: 1,
      lifecycle_state: "active", created_at: NOW, updated_at: NOW, created_by: "user_action",
      evidence_kind: "conversation_excerpt", evidence_health_state: "verified",
      semantic_anchor: { topic: "blue", keywords: ["blue"], summary: "recommended blue" },
      event_anchor: null, physical_anchor: null, gist: "The assistant recommended blue.",
      excerpt: "The assistant recommended blue.", source_hash: null,
      workspace_id: "workspace-1", run_id: "run-1", surface_id: null
    };
    await fixture.storage.evidenceCapsuleRepo.create(capsule);
    const before = fixture.database.connection.prepare("SELECT COUNT(*) AS count FROM garden_tasks").get();
    const scoreEvidenceCandidates = vi.fn(async () => { throw new Error("query-time scoring forbidden"); });
    const prepareQuerySupplement = vi.fn(async () => { throw new Error("query-time provider forbidden"); });
    const querySupplement = vi.fn(async () => { throw new Error("query-time provider forbidden"); });
    const service = new RecallService({
      ...fixture.dependencies,
      ...(withScoring ? { embeddingRecallService: { scoreEvidenceCandidates, prepareQuerySupplement, querySupplement } } : {})
    });
    const result = await service.recall({
      workspaceId: "workspace-1", taskSurface: { ...createTaskSurface(), display_name: "blue" },
      queryText: "blue", strategy: "chat", pageBudget: 800
    });
    expect(result.candidates.some((candidate) => candidate.object_id === MEMORY_ID)).toBe(true);
    expect(result.index.entries.some((entry) => entry.object_id === MEMORY_ID)).toBe(true);
    expect(scoreEvidenceCandidates).not.toHaveBeenCalled();
    expect(prepareQuerySupplement).not.toHaveBeenCalled();
    expect(querySupplement).not.toHaveBeenCalled();
    expect(fixture.database.connection.prepare("SELECT COUNT(*) AS count FROM garden_tasks").get()).toEqual(before);
    expect(await fixture.storage.evidenceCapsuleRepo.findByIds("workspace-1", [EVIDENCE_ID])).toEqual([capsule]);
    expect(await fixture.storage.evidenceCapsuleRepo.findByIds("workspace-other", [EVIDENCE_ID])).toEqual([]);
    const storedHits = await fixture.storage.evidenceCapsuleRepo.searchByKeyword("workspace-1", "blue", 10);
    expect(storedHits.some((hit) => hit.object_id === EVIDENCE_ID)).toBe(true);
  });

  it("does not use transient scoring to hide an unavailable source reader", async () => {
    const fixture = await createSourceBoundRecallFixture((database) => databases.add(database));
    await fixture.writeMemory(MEMORY_ID, "The assistant recommended blue.", MemoryDimension.FACT);
    const scoreEvidenceCandidates = vi.fn(async () => { throw new Error("query-time scoring forbidden"); });
    const querySupplement = vi.fn(async () => { throw new Error("query-time provider forbidden"); });
    const service = new RecallService({
      ...fixture.dependencies,
      observerReaders: { ...fixture.dependencies.observerReaders,
        source: () => ({ row: null, rowsRead: 1, bytesRead: 0, unavailable: true }) },
      embeddingRecallService: { scoreEvidenceCandidates, querySupplement }
    });
    const result = await service.recall({
      workspaceId: "workspace-1", taskSurface: { ...createTaskSurface(), display_name: "blue" },
      queryText: "blue", strategy: "chat", pageBudget: 800
    });
    expect(result.index.completeness.logical_index).not.toBe("complete");
    expect(scoreEvidenceCandidates).not.toHaveBeenCalled();
    expect(querySupplement).not.toHaveBeenCalled();
  });
});
