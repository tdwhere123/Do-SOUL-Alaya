import { afterEach, describe, expect, it, vi } from "vitest";
import { capableRecallConsumerDeclaration, RecallService } from "../../recall/recall-service.js";
import {
  createRecallDatabaseRegistry,
  createSourceBoundRecallFixture,
  createTaskSurface
} from "./recall-service-test-fixtures.js";
import { createClaimForm } from "../governance/claim-service.test-support.js";

const registry = createRecallDatabaseRegistry();
afterEach(() => {
  vi.restoreAllMocks();
  registry.closeAll();
});
const fixture = () => createSourceBoundRecallFixture(registry.register);
const request = () => ({
  taskSurface: createTaskSurface(),
  workspaceId: "workspace-1",
  strategy: "analyze" as const,
  queryText: "deployment checklist"
});
const AS_OF = "2023-05-30T23:40:00.000Z";

describe("RecallService conditional entry", () => {
  it("delivers positive raw source evidence without a provider or durable query mutation", async () => {
    const f = await fixture();
    await f.writeMemory("aaaaaaaa-aaaa-4aaa-8aaa-000000000001", "deployment checklist", "procedure");
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("provider forbidden"));
    const before = f.database.connection.prepare("SELECT COUNT(*) AS count FROM event_log").get();
    const pending = f.pendingGarden();
    const result = await f.service.recall(request());
    expect(result.candidates.map((row) => row.object_id)).toContain("aaaaaaaa-aaaa-4aaa-8aaa-000000000001");
    expect(result.index.entries[0]?.claim).toBe("unknown");
    expect(result.index.completeness.interpretation_coverage).not.toBe("complete");
    expect(f.database.connection.prepare("SELECT COUNT(*) AS count FROM event_log").get()).toEqual(before);
    expect(f.pendingGarden()).toEqual(pending);
    expect(network).not.toHaveBeenCalled();
    expect(result.provider_calls).toBe(0);
  });

  it("keeps unavailable source observation distinct from an observed empty workspace", async () => {
    const f = await fixture();
    const empty = await f.service.recall(request());
    const unavailable = await new RecallService({
      ...f.dependencies,
      observerReaders: { snapshotPin: f.dependencies.observerReaders!.snapshotPin }
    }).recall({ ...capableRecallConsumerDeclaration(), ...request() });
    expect(empty.candidates).toEqual([]);
    expect(empty.index.completeness.observed_coverage).not.toBe("unavailable");
    expect(unavailable.candidates).toEqual([]);
    expect(unavailable.index.completeness.observed_coverage).toBe("unavailable");
  });
});

describe("RecallService constraints remain independent of index pagination", () => {
  it("keeps every active constraint outside a three-entry source page", async () => {
    const f = await fixture();
    const ids: string[] = [];
    for (let offset = 1; offset <= 6; offset += 1) {
      const objectId = `aaaaaaaa-aaaa-4aaa-8aaa-${String(offset).padStart(12, "0")}`;
      await f.writeMemory(objectId, "deployment checklist", "constraint");
      await f.claimFormRepo.create(createClaimForm({
        object_id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(offset).padStart(12, "0")}`,
        workspace_id: "workspace-1",
        claim_status: "active",
        source_object_refs: [objectId]
      }));
      ids.push(objectId);
    }
    const result = await f.service.recall({ ...request(), pageBudget: 3 });
    expect(result.candidates).toHaveLength(3);
    expect(result.active_constraints.map((entry) => entry.object_id)).toEqual(ids);
    expect(result.active_constraints_count).toBe(6);
  });
});

describe("RecallService real SQLite source delivery", () => {
  it("delivers every matching planted source with sufficient page budget across storage tiers", async () => {
    const f = await fixture();
    const ids: string[] = [];
    for (const [offset, tier] of ["hot", "warm", "cold"].entries()) {
      const id = `aaaaaaaa-aaaa-4aaa-8aaa-${String(offset).padStart(12, "0")}`;
      ids.push(id);
      await f.writeMemory(id, "deployment checklist", "procedure");
      f.database.connection.prepare("UPDATE memory_entries SET storage_tier = ? WHERE object_id = ?").run(tier, id);
    }
    const result = await f.service.recall({ ...request(), pageBudget: 10 });
    expect(result.candidates.map((row) => row.object_id).sort()).toEqual(ids.sort());
    expect(result.candidates.every((row) => row.content_preview === "deployment checklist")).toBe(true);
  });

  it("bounds the structured page and retains continuation instead of imposing a rank cutoff", async () => {
    const f = await fixture();
    for (let index = 0; index < 6; index += 1) {
      await f.writeMemory(
        `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`,
        "deployment checklist",
        "procedure"
      );
    }
    const first = await f.service.recall({ ...request(), pageBudget: 2 });
    expect(first.index.entries).toHaveLength(2);
    expect(first.index.continuation).not.toBeNull();
    const next = await f.service.recall({ ...request(), pageBudget: 2, continuation: first.index.continuation });
    expect(next.index.snapshot_id).toBe(first.index.snapshot_id);
    expect(next.index.query_id).toBe(first.index.query_id);
    expect(next.index.entries).toHaveLength(2);
    expect(next.index.entries.some((entry) => first.index.entries.some((seen) =>
      seen.object_id === entry.object_id && seen.hypothesis_id === entry.hypothesis_id && seen.output_binding === entry.output_binding
    ))).toBe(false);
  });

  it("does not expose a tombstone or turn an unrelated source into a matching result", async () => {
    const f = await fixture();
    await f.writeMemory("aaaaaaaa-aaaa-4aaa-8aaa-000000000001", "deployment checklist", "procedure");
    f.database.connection.prepare("UPDATE memory_entries SET retention_state = 'tombstoned'").run();
    await f.writeMemory("aaaaaaaa-aaaa-4aaa-8aaa-000000000099", "unrelated volcanic ash", "fact");
    const result = await f.service.recall(request());
    expect(result.candidates).toEqual([]);
    expect(result.index.completeness.interpretation_coverage).not.toBe("complete");
  });
});

describe("historical source Recall with unavailable optional projections", () => {
  it("retains historical sources and marks unavailable governance explicitly", async () => {
    const f = await fixture();
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
    await f.writeSource({ objectId: id, content: "deployment checklist", createdAt: "2023-05-29T12:00:00.000Z" });
    await f.claimFormRepo.create(createClaimForm({
      workspace_id: "workspace-1",
      claim_status: "active",
      source_object_refs: [id],
      created_at: "2023-05-29T12:00:00.000Z",
      updated_at: "2026-09-06T12:00:00.000Z"
    }));
    const result = await f.service.recall({ ...request(), referenceTime: AS_OF });
    expect(result.candidates.map((entry) => entry.object_id)).toEqual([id]);
    expect(result.index.as_of).toBe(AS_OF);
    expect(result.active_constraints).toEqual([]);
    expect(result.active_constraints_count).toBeNull();
    expect(result.active_constraints_completeness).toBe("incomplete");
    expect(result.index.completeness.interpretation_coverage).not.toBe("complete");
  });
});
