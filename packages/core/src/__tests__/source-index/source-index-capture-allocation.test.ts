import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SourceIndexLifecycle } from "../../source-index/source-index-lifecycle.js";
import { initDatabase, type StorageDatabase } from "../../../../storage/src/sqlite/db.js";
import { SqliteSourceIndexRepository } from "../../../../storage/src/repos/source-index/source-index-repo.js";
import { BUDGET, WORKSPACE, fieldSha256, fixture, publishSource } from
  "../../../../storage/src/__tests__/repos/source-index/source-index-fixture.js";
import { publishFullContextStatement } from
  "../../../../storage/src/__tests__/repos/source-index/source-template-fixture.js";

const databases: StorageDatabase[] = [], directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) if (!database.isClosed()) database.close({ optimize: false });
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const limits = { work: 25_000, native_bytes: 2 * 1024 * 1024, capture_page: 128,
  max_capture_pages: 8, max_roots: 200, max_body_bytes: 65536 };

it("returns one actionable lexical refusal per allocation, survives reopen and recovers the same generation with every root", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lexical-capture-allocation-")); directories.push(directory);
  const h = fixture(join(directory, "index.sqlite")); databases.push(h.database);
  const { first, later } = await publishFullContextStatement(h);
  const selection = h.index.lexical.selectLexical(WORKSPACE, "raw-unicode61.v1");
  const generation = h.index.lexical.beginLexical(selection);
  h.index.lexical.captureLexicalPage(WORKSPACE, generation.generation_id, 128, BUDGET);
  expect(h.index.lexical.captureLexicalPage(WORKSPACE, generation.generation_id, 2, BUDGET).generation)
    .toMatchObject({ records_complete: true, after_capsule_cursor: null, target_count: 129 });
  h.database.close({ optimize: false });
  const database = initDatabase({ filename: join(directory, "index.sqlite") }); databases.push(database);
  const index = new SqliteSourceIndexRepository(database, fieldSha256);
  const lifecycle = new SourceIndexLifecycle(index, fieldSha256);
  const capture = vi.spyOn(index.lexical, "captureLexicalPage"), reclaim = vi.spyOn(index.lexical, "reclaimLexicalPage");
  const activate = vi.spyOn(index.lexical, "activateLexical"), read = vi.spyOn(index.lexical, "readLexicalDocument");
  for (let round = 0; round < 3; round++) {
    capture.mockClear(); reclaim.mockClear();
    const receipt = await lifecycle.prepareLexical(WORKSPACE, "raw-unicode61.v1", { ...limits, work: 324 });
    expect(receipt).toMatchObject({ status: "unavailable", reason: "enumeration_allocation_exhausted", accounting: "complete",
      capture_pages: 1, visited_roots: 0, model_inputs: 0, generation: { generation_id: generation.generation_id,
        status: "partial", enumeration_complete: false, after_capsule_cursor: null, target_count: 129 } });
    expect(capture).toHaveBeenCalledTimes(1); expect(activate).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
    const costs = [...capture.mock.results, ...reclaim.mock.results].map(result => result.value.resources);
    expect(receipt.resources).toEqual({ work: costs.reduce((n, cost) => n + cost.work, 0),
      native_bytes: costs.reduce((n, cost) => n + cost.native_bytes, 0) });
    expect(receipt.resources.work).toBeGreaterThan(0); expect(receipt.resources.work).toBeLessThanOrEqual(324);
    expect(receipt.resources.native_bytes).toBeLessThanOrEqual(limits.native_bytes);
    expect(index.lexical.lexicalState(WORKSPACE)?.active_generation_id).toBeNull();
    expect(database.connection.prepare(`SELECT count(*) AS n FROM source_index_lexical_targets t JOIN source_index_roots r
      ON r.workspace_id=t.workspace_id AND r.root_key=t.root_key WHERE t.generation_id=? AND (r.root_key=? OR r.record_id=?)`).get(generation.generation_id, first.source.root_key, later.object_id)).toEqual({ n: 0 });
  }
  const recovered = await lifecycle.prepareLexical(WORKSPACE, "raw-unicode61.v1", limits);
  expect(recovered).toMatchObject({ status: "ready", reason: null, generation: { generation_id: generation.generation_id,
    enumeration_complete: true, target_count: 131, completed_count: 131 } });
  expect(index.lexical.lexicalState(WORKSPACE)?.active_generation_id).toBe(generation.generation_id);
  const roots = database.connection.prepare(`SELECT r.root_key,r.record_id FROM source_index_lexical_targets t JOIN source_index_roots r
    ON r.workspace_id=t.workspace_id AND r.root_key=t.root_key WHERE t.generation_id=?`).all(generation.generation_id);
  expect(roots).toContainEqual(expect.objectContaining({ root_key: first.source.root_key }));
  expect(roots).toContainEqual(expect.objectContaining({ record_id: later.object_id }));
});

it("continues normal cursor-progress pages and publishes ready and valid-empty populations", async () => {
  const h = fixture(); databases.push(h.database);
  publishSource(h, "first", "a"); publishSource(h, "second", "b");
  const lifecycle = new SourceIndexLifecycle(h.index, fieldSha256);
  const activate = vi.spyOn(h.index.lexical, "activateLexical");
  const budgetEnd = await lifecycle.prepareLexical(WORKSPACE, "raw-unicode61.v1", { ...limits, work: 330, capture_page: 1 });
  expect(budgetEnd).toMatchObject({ status: "partial", reason: "enumeration_budget", capture_pages: 2,
    generation: { target_count: 1, enumeration_complete: false } });
  const partial = await lifecycle.prepareLexical(WORKSPACE, "raw-unicode61.v1", { ...limits, capture_page: 1, max_capture_pages: 1 });
  expect(partial).toMatchObject({ status: "partial", reason: "enumeration_page", capture_pages: 1,
    generation: { target_count: 2, completed_count: 2, enumeration_complete: false } });
  expect(activate).not.toHaveBeenCalled();
  expect(await lifecycle.prepareLexical(WORKSPACE, "raw-unicode61.v1", limits)).toMatchObject({ status: "ready",
    generation: { generation_id: partial.generation!.generation_id, target_count: 2, completed_count: 2 } });
  expect(await lifecycle.prepareLexical("workspace-2", "raw-unicode61.v1", limits)).toMatchObject({ status: "ready",
    generation: { status: "valid_empty", enumeration_complete: true, target_count: 0 } });
});
