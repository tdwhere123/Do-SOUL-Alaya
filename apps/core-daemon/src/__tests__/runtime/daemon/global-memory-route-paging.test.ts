import { afterEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { MemoryDimension, ScopeClass } from "@do-soul/alaya-protocol";
import type { ProjectMappingService } from "@do-soul/alaya-core";
import { initDatabase, SqliteGlobalMemoryRepo, type StorageDatabase } from "@do-soul/alaya-storage";
import { createGlobalMemoryRouteService } from "../../../runtime/daemon/lifecycle/daemon-runtime-support.js";
import { registerGlobalMemoryRoutes } from "../../../routes/memory/entries/global-memory.js";
import { registerErrorHandler } from "../../../middleware/error-handler.js";
import { globalMemoryRouteServices } from "../../support/route-service-stubs.js";
import { implementPort } from "../../support/implement-port.js";

const databases = new Set<StorageDatabase>();
afterEach(() => { for (const database of databases) database.close(); databases.clear(); });

it("returns the exact bounded HTTP page from a population above the repository default cap", async () => {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  const repo = new SqliteGlobalMemoryRepo(database);
  const ids = Array.from({ length: 601 }, (_, index) => `global-${String(index).padStart(4, "0")}`);
  for (const id of ids) await repo.upsert({
    global_object_id: id, object_kind: "global_memory_entry", canonical_identity: `procedure::${id}`,
    dimension: MemoryDimension.PROCEDURE, scope_class: ScopeClass.GLOBAL_CORE,
    content: `Procedure ${id}`, domain_tags: [], provenance: "seed://paging-test", activation_score: null,
    version: 1, created_at: "2026-04-23T00:00:00.000Z", updated_at: "2026-04-23T00:00:00.000Z"
  });
  expect(await repo.list()).toHaveLength(500);
  const service = createGlobalMemoryRouteService({ globalMemoryRepo: repo,
    projectMappingService: implementPort<ProjectMappingService>() });
  const app = new Hono();
  registerErrorHandler(app, { error: vi.fn() });
  registerGlobalMemoryRoutes(app, globalMemoryRouteServices({ globalMemoryService: service }));
  const accepted = await app.request("/soul/global-memory-entries?limit=200");
  expect(accepted.status).toBe(200);
  const body = await accepted.json() as { success: boolean; data: { total: number; entries: { global_object_id: string }[] } };
  expect(body).toMatchObject({ success: true, data: { total: 200 } });
  expect(body.data.entries.map(entry => entry.global_object_id)).toEqual(ids.slice(0, 200));
  const rejected = await app.request("/soul/global-memory-entries?limit=501");
  expect(rejected.status).toBe(400);
});
