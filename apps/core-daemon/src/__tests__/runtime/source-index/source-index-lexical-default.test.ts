import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const url = new URL("../../../../../../packages/core/src/__tests__/embedding-recall/authored-source-embedding-guard.mjs", import.meta.url);
  return (await import(/* @vite-ignore */ url.href)).isolation;
});
afterAll(() => { expect(isolation.violations).toEqual([]); isolation.restore(); });
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SOURCE_INDEX_DEFAULT_LEXICAL_REPRESENTATION } from "@do-soul/alaya-protocol";
import { SourceIndexLifecycle, createSourceAdmissionPort } from "@do-soul/alaya-core";
import { initDatabase, SqliteSourceIndexRepository, SqliteEvidenceCapsuleRepo } from "@do-soul/alaya-storage";
import { __resetCjkSegmentationStateForTests, __setCjkSegmentationLoaderForTests, warmCjkSegmentation } from "@do-soul/alaya-cjk-segmentation";
import { fixture, buildReady, eraseSource, publishSource, configuration, CLOCK, fieldSha256, BUDGET, WORKSPACE } from "../../../../../../packages/storage/src/__tests__/repos/source-index/source-index-fixture.js";
import { createDaemonFieldRepos } from "../../../runtime/field/field-repos.js";
import { createSqliteFieldFormationStores } from "../../../runtime/field/sqlite-field-formation-stores.js";
import { SourceIndexProducer } from "../../../runtime/source-index/source-index-producer.js";

const queryBudget = { work_units: 100_000, memory_bytes: 16 * 1024 * 1024 };
const limits = { ...BUDGET, capture_page: 8, max_capture_pages: 4, max_roots: 8, max_body_bytes: 65536 };
const oldBody = "release notes 自动部署流水线 维护服务";
const newBody = "quarterly planning 数据库迁移方案";
afterEach(() => __resetCjkSegmentationStateForTests());
function admit(database: ReturnType<typeof fixture>["database"], text: string, sourceId: string) {
  return createSourceAdmissionPort({ sha256: fieldSha256,
    stores: createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) }) }).admit({
    workspace_id: WORKSPACE, source_id: sourceId, source_version: "1", content_bytes: text,
    recorded_at: "2026-09-13T00:00:00Z", event_time: null, valid_from: null, valid_to: null, evidence_object_id: null,
    source_representation: { kind: "original_body" }, spans: []
  }, { workspaceId: WORKSPACE });
}
const roots = (index: ReturnType<typeof fixture>["index"], query: string) =>
  index.readLexicalCandidates(WORKSPACE, query, 8, queryBudget).candidates.map(row => row.source.target.root_id);

it("schedules the default lexical representation with embedding disabled and serves raw until it publishes", async () => {
  const { database, index } = fixture();
  const bind = vi.fn(async () => ({ status: "unsupported" as const, reason: "runtime_missing" }));
  const producer = new SourceIndexProducer({ database, bindSourceEmbedding: bind, warn: vi.fn() });
  try {
    const old = admit(database, oldBody, "old-source");
    index.lexical.selectLexical(WORKSPACE, SOURCE_INDEX_DEFAULT_LEXICAL_REPRESENTATION);
    const before = index.readLexicalCandidates(WORKSPACE, "release", 8, queryBudget);
    expect(before).toMatchObject({ completion: "complete" });
    expect(before.tokenization).not.toHaveProperty("lexical_binding");
    await producer.runPass();
    expect(database.connection.prepare("SELECT count(*) AS n FROM source_index_vectors").get()).toEqual({ n: 0 });
    const state = index.lexical.lexicalState(WORKSPACE);
    expect(state?.selection.representation).toBe("segmented-unicode61.v1");
    expect(state?.active_generation_id).not.toBeNull();
    const after = index.readLexicalCandidates(WORKSPACE, "部署", 8, queryBudget);
    expect(after.tokenization).toMatchObject({ lexical_binding: { representation: "segmented-unicode61.v1" } });
    expect(after.candidates.map(row => row.source.target.root_id)).toEqual([old.record.identity]);
  } finally { await producer.stop(); database.close({ optimize: false }); }
});

it("prepares the default for a workspace without a selection and honors an explicit raw selection", async () => {
  const { database, index } = fixture();
  const producer = new SourceIndexProducer({ database, warn: vi.fn(),
    bindSourceEmbedding: async () => ({ status: "unsupported", reason: "runtime_missing" }) });
  try {
    admit(database, oldBody, "old-source");
    expect(index.lexical.lexicalState(WORKSPACE)).toBeNull();
    await producer.runPass();
    expect(index.lexical.lexicalState(WORKSPACE)?.selection.representation).toBe(SOURCE_INDEX_DEFAULT_LEXICAL_REPRESENTATION);
    index.lexical.selectLexical(WORKSPACE, "raw-unicode61.v1");
    await producer.runPass();
    expect(index.lexical.lexicalState(WORKSPACE)).toMatchObject({ selection: { representation: "raw-unicode61.v1" } });
    expect(index.lexical.lexicalState(WORKSPACE)?.active_generation_id).not.toBeNull();
  } finally { await producer.stop(); database.close({ optimize: false }); }
});

it("analyzes only the new root in the next epoch and keeps unchanged roots searchable", async () => {
  const { database, index } = fixture();
  try {
    const old = admit(database, oldBody, "old-source");
    const lifecycle = new SourceIndexLifecycle(index, fieldSha256);
    const first = await lifecycle.prepareLexical(WORKSPACE, "segmented-unicode61.v1", limits);
    expect(first).toMatchObject({ status: "ready", analysis_units: oldBody.length });
    const added = admit(database, newBody, "new-source");
    const second = await lifecycle.prepareLexical(WORKSPACE, "segmented-unicode61.v1", limits);
    expect(second).toMatchObject({ status: "ready", analysis_units: newBody.length,
      generation: { target_count: 2, completed_count: 2 } });
    expect(second.generation!.generation_id).not.toBe(first.generation!.generation_id);
    expect(roots(index, "部署")).toEqual([old.record.identity]);
    expect(roots(index, "迁移")).toEqual([added.record.identity]);
    expect(index.readLexicalCandidates(WORKSPACE, "部署", 8, queryBudget).tokenization?.lexical_binding?.generation_id)
      .toBe(second.generation!.generation_id);
    expect(database.connection.prepare("SELECT count(*) AS n FROM source_index_lexical_projections WHERE generation_id=?")
      .get(second.generation!.generation_id)).toEqual({ n: 2 });
    expect(await lifecycle.prepareLexical(WORKSPACE, "segmented-unicode61.v1", limits)).toMatchObject({ status: "ready", analysis_units: 0 });
  } finally { database.close({ optimize: false }); }
});
