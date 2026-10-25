import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const url = new URL("../../../../../../packages/core/src/__tests__/embedding-recall/authored-source-embedding-guard.mjs", import.meta.url);
  return (await import(/* @vite-ignore */ url.href)).isolation;
});
afterAll(() => { expect(isolation.violations).toEqual([]); isolation.restore(); });
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceIndexLifecycle, createSourceAdmissionPort } from "@do-soul/alaya-core";
import { initDatabase, SqliteSourceIndexRepository, SqliteEvidenceCapsuleRepo } from "@do-soul/alaya-storage";
import { __resetCjkSegmentationStateForTests, __setCjkSegmentationLoaderForTests, warmCjkSegmentation } from "@do-soul/alaya-cjk-segmentation";
import { fixture, buildReady, eraseSource, publishSource, configuration, CLOCK, fieldSha256, BUDGET, WORKSPACE } from "../../../../../../packages/storage/src/__tests__/repos/source-index/source-index-fixture.js";
import { createDaemonFieldRepos } from "../../../runtime/field/field-repos.js";
import { createSqliteFieldFormationStores } from "../../../runtime/field/sqlite-field-formation-stores.js";
import { SourceIndexProducer } from "../../../runtime/source-index/source-index-producer.js";

const queryBudget = { work_units: 100_000, memory_bytes: 16 * 1024 * 1024 };
const limits = { ...BUDGET, capture_page: 8, max_capture_pages: 4, max_roots: 8, max_body_bytes: 65536 };
const body = "Alpha-BETA, release! 自动部署流水线 "+Array.from({ length: 20 }, (_, i) => `word${i}`).join(" ")+" 维护服务";
afterEach(() => __resetCjkSegmentationStateForTests());
function admit(database: ReturnType<typeof fixture>["database"], text = body, sourceId = "authored-deployment", version = "1") {
  return createSourceAdmissionPort({ sha256: fieldSha256,
    stores: createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) }) }).admit({
    workspace_id: WORKSPACE, source_id: sourceId, source_version: version, content_bytes: text,
    recorded_at: version === "1" ? "2026-09-13T00:00:00Z" : "2026-09-14T00:00:00Z",
    event_time: null, valid_from: null, valid_to: null, evidence_object_id: null,
    source_representation: { kind: "original_body" }, spans: []
  }, { workspaceId: WORKSPACE });
}

it("uses the idle daemon preparation entry on a fresh admitted source with embedding disabled", async () => {
  const { startBenchDaemon } = await import("../../../../../bench-runner/src/harness/daemon.js");
  const directory = mkdtempSync(join(tmpdir(), "lexical-daemon-"));
  let daemon: Awaited<ReturnType<typeof startBenchDaemon>> | undefined;
  try {
    daemon = await startBenchDaemon({ dataDirRoot: directory, configDirectoryRoot: directory,
      workspaceId: WORKSPACE, runId: "run-1", embeddingMode: "disabled", sqliteWriteQueue: "disabled",
      embeddingStartupProbe: "omit", gardenCompute: "disabled", fieldProjectionAdmissionMode: "explicit_checkpoint" });
    await daemon.importSourceRecord({ source_id: "fresh-daemon", source_version: "1", content_bytes: body,
      recorded_at: CLOCK, event_time: null, valid_from: null, valid_to: null, scope_class: "project", spans: [] });
    if (daemon.runtime.runSourceIndexLexicalPass === undefined) throw new Error("lexical preparation unwired");
    const pass = await daemon.runtime.runSourceIndexLexicalPass(WORKSPACE, "segmented-unicode61.v1");
    expect(pass).toMatchObject({ status: "ready", model_inputs: 0, analysis_units: body.length,
      generation: { status: "ready", target_count: 1 } });
    await daemon.shutdown(); daemon = undefined;
    const database = initDatabase({ filename: join(directory, "alaya.db") });
    try {
      expect(database.connection.prepare("SELECT count(*) AS n FROM source_index_vectors").get()).toEqual({ n: 0 });
      expect(database.connection.prepare("SELECT count(*) AS n FROM source_index_lexical_fts WHERE source_index_lexical_fts MATCH '部署'").get()).toEqual({ n: 1 });
      expect(database.connection.prepare("SELECT body FROM source_index_text").get()).toEqual({ body });
    } finally { database.close({ optimize: false }); }
  } finally { await daemon?.shutdown(); rmSync(directory, { recursive: true, force: true }); }
}, 30_000);

it("prepares fresh admitted bytes without binding a model, matches embedded words, and reopens exact originals", async () => {
  const directory = mkdtempSync(join(tmpdir(), "source-lexical-")), filename = join(directory, "source.sqlite");
  let { database, index } = fixture(filename);
  const bind = vi.fn(async () => { throw new Error("lexical preparation must not bind embedding"); });
  let producer: SourceIndexProducer | undefined;
  try {
    const source = admit(database);
    expect(database.connection.prepare("SELECT count(*) AS n FROM source_index_text").get()).toEqual({ n: 0 });
    producer = new SourceIndexProducer({ database, bindSourceEmbedding: bind, warn: vi.fn() });
    const raw = await producer.runLexicalPass(WORKSPACE, "raw-unicode61.v1");
    expect(raw).toMatchObject({ status: "ready", model_inputs: 0, analysis_units: 0 });
    expect(index.readLexicalCandidates(WORKSPACE, "部署", 8, queryBudget).candidates).toEqual([]);
    expect(index.readLexicalCandidates(WORKSPACE, "alpha BETA", 8, queryBudget).candidates.map(row => row.source.target.root_id))
      .toEqual([source.record.identity]);
    expect(index.readLexicalCandidates(WORKSPACE, "流水线", 8, queryBudget).candidates.map(row => row.source.target.root_id))
      .toContain(source.record.identity);
    const prepared = await producer.runLexicalPass(WORKSPACE, "segmented-unicode61.v1");
    expect(prepared).toMatchObject({ status: "ready", model_inputs: 0, analysis_units: body.length,
      generation: { status: "ready", target_count: 1, completed_count: 1 } });
    expect(bind).not.toHaveBeenCalled();
    index.select(WORKSPACE, configuration({ model_revision: "different-vector-only", window_bytes: 16 }));
    const query = index.readLexicalCandidates(WORKSPACE, "部署", 8, queryBudget);
    expect(query).toMatchObject({ completion: "complete", tokenization: { cjk_state: "ready",
      lexical_binding: { representation: "segmented-unicode61.v1", generation_id: prepared.generation!.generation_id } } });
    expect(query.candidates.map(row => row.source.target.root_id)).toEqual([source.record.identity]);
    expect(index.readLexicalCandidates(WORKSPACE, "维护", 8, queryBudget).candidates).toHaveLength(1);
    expect(index.readLexicalCandidates(WORKSPACE, "배포", 8, queryBudget)).toMatchObject({
      completion: "partial", reason: "short_cjk_exact_tokens_only", limitations: expect.arrayContaining(["short_cjk_unicode61_exact_tokens_only"]) });
    expect(index.readLexicalCandidates(WORKSPACE, "alpha BETA", 8, queryBudget).candidates).toHaveLength(1);
    expect(index.readLexicalCandidates(WORKSPACE, "流水线", 8, queryBudget).candidates.some(row => row.lexical.lane === "trigram")).toBe(true);
    expect(database.connection.prepare("SELECT body,content_digest FROM source_index_text").get())
      .toEqual({ body, content_digest: source.record.content_digest });
    const projection = database.connection.prepare("SELECT projection FROM source_index_lexical_projections WHERE generation_id=?")
      .get(prepared.generation!.generation_id) as { projection: string };
    expect(projection.projection).toContain("Alpha-BETA, release!");
    expect(projection.projection).toContain("自动部署流水线 自动 部署 流水线");
    await producer.stop(); producer = undefined;
    database.close({ optimize: false }); database = initDatabase({ filename });
    index = new SqliteSourceIndexRepository(database, fieldSha256);
    const reopened = index.readLexicalCandidates(WORKSPACE, "部署", 8, queryBudget);
    expect(reopened.tokenization).toEqual(query.tokenization);
    expect(reopened.candidates.map(row => row.source.target.root_id)).toEqual([source.record.identity]);
    const replay = await new SourceIndexLifecycle(index, fieldSha256).prepareLexical(WORKSPACE, "segmented-unicode61.v1", limits);
    expect(replay).toMatchObject({ status: "ready", analysis_units: 0, generation: { generation_id: prepared.generation!.generation_id } });
  } finally { await producer?.stop(); database.close({ optimize: false }); rmSync(directory, { recursive: true, force: true }); }
});

it("does not serve or publish a cold, loading, unavailable or failing strict analyzer", async () => {
  const { database, index } = fixture();
  try {
    admit(database);
    const lifecycle = new SourceIndexLifecycle(index, fieldSha256);
    const prepared = await lifecycle.prepareLexical(WORKSPACE, "segmented-unicode61.v1", limits);
    expect(prepared.status).toBe("ready");
    __resetCjkSegmentationStateForTests();
    expect(index.readLexicalCandidates(WORKSPACE, "部署", 8, queryBudget)).toMatchObject({ completion: "unavailable", reason: "segmenter_uninitialized" });
    expect(index.lexical.activateLexical(WORKSPACE, prepared.generation!.generation_id)).toEqual({ status: "rejected", reason: "incomplete" });
    let resolve!: (value: null) => void;
    __setCjkSegmentationLoaderForTests(() => new Promise(done => { resolve = done; }));
    const warming = warmCjkSegmentation();
    expect(index.readLexicalCandidates(WORKSPACE, "部署", 8, queryBudget)).toMatchObject({ completion: "unavailable", reason: "segmenter_loading" });
    resolve(null); await warming;
    expect(await lifecycle.prepareLexical(WORKSPACE, "segmented-unicode61.v1", limits)).toMatchObject({ status: "unavailable", reason: "segmenter_unavailable" });
    __setCjkSegmentationLoaderForTests(async () => ({ cut: () => { throw new Error("authored analyzer failure"); } }));
    await warmCjkSegmentation();
    expect(index.readLexicalCandidates(WORKSPACE, "部署", 8, queryBudget)).toMatchObject({ completion: "unavailable", tokenization: null });
    expect(index.lexical.activateLexical(WORKSPACE, prepared.generation!.generation_id)).toEqual({ status: "rejected", reason: "incomplete" });
    const fresh = admit(database, "新系统部署完成", "fresh");
    const failed = await lifecycle.prepareLexical(WORKSPACE, "segmented-unicode61.v1", limits);
    expect(failed.status).toBe("unavailable");
    expect(database.connection.prepare("SELECT count(*) AS n FROM source_index_lexical_projections WHERE root_key LIKE ?")
      .get(`%${fresh.record.identity}%`)).toEqual({ n: 0 });
  } finally { database.close({ optimize: false }); }
});

it("distinguishes bounded-out from valid-empty and scrubs capsule and canonical dependency projections", async () => {
  const environment = fixture(), { database, index } = environment;
  try {
    const lifecycle = new SourceIndexLifecycle(index, fieldSha256);
    expect(await lifecycle.prepareLexical(WORKSPACE, "segmented-unicode61.v1", { ...limits, work: 0 }))
      .toMatchObject({ status: "partial", generation: { enumeration_complete: false } });
    const empty = await lifecycle.prepareLexical(WORKSPACE, "segmented-unicode61.v1", limits);
    expect(empty).toMatchObject({ status: "ready", generation: { status: "valid_empty", target_count: 0 } });
    expect(index.readLexicalCandidates(WORKSPACE, "部署", 8, queryBudget)).toMatchObject({ completion: "complete", candidates: [] });
    const root = await new SqliteEvidenceCapsuleRepo(database).create({
      object_id: "cccccccc-cccc-4ccc-8ccc-000000000201", object_kind: "evidence_capsule", schema_version: 1,
      lifecycle_state: "active", created_at: CLOCK, updated_at: CLOCK, created_by: "user_action",
      evidence_kind: "conversation_excerpt", semantic_anchor: { topic: "authored", keywords: ["source"], summary: "authored" },
      event_anchor: null, physical_anchor: null, evidence_health_state: "verified", gist: "unchosen gist",
      excerpt: "自动部署流水线", source_hash: null, run_id: "run-1", workspace_id: WORKSPACE, surface_id: null
    });
    const origin = admit(database, "origin retained bytes", "origin");
    const derived = publishSource(environment, "自动部署流水线", "derived", {
      source_representation: { kind: "canonical_projection", source_record_ids: [origin.record.identity] }
    });
    expect(await lifecycle.prepareLexical(WORKSPACE, "segmented-unicode61.v1", limits)).toMatchObject({ status: "ready" });
    const hits = index.readLexicalCandidates(WORKSPACE, "部署", 8, queryBudget).candidates;
    expect(hits.map(row => row.source.target.root_id).sort()).toEqual([root.object_id, derived.record_id].sort());
    expect(hits.find(row => row.source.target.root_id === root.object_id)?.source.source_id).toBeNull();
    // A later selection retains historical projection payloads until the common erase closure scrubs them.
    await lifecycle.prepareLexical(WORKSPACE, "raw-unicode61.v1", limits);
    await lifecycle.prepareLexical(WORKSPACE, "segmented-unicode61.v1", limits);
    eraseSource(environment, origin.record.identity);
    expect(index.readLexicalCandidates(WORKSPACE, "部署", 8, queryBudget).candidates.map(row => row.source.target.root_id))
      .toEqual([root.object_id]);
    expect(database.connection.prepare("SELECT count(*) AS n FROM source_index_lexical_projections WHERE root_key=?")
      .get(hits.find(row => row.source.target.root_id === derived.record_id)!.source.root_key)).toEqual({ n: 0 });
    await new SqliteEvidenceCapsuleRepo(database).deleteById(root.object_id);
    expect(index.readLexicalCandidates(WORKSPACE, "部署", 8, queryBudget).candidates).toEqual([]);
    expect(database.connection.prepare("SELECT count(*) AS n FROM source_index_lexical_projections WHERE root_key=?")
      .get(hits.find(row => row.source.target.root_id === root.object_id)!.source.root_key)).toEqual({ n: 0 });
  } finally { database.close({ optimize: false }); }
});

it("resumes a bounded generation, fences stale writers, repairs lost payloads, and leaves vector identities alone", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lexical-resume-")), filename = join(directory, "source.sqlite");
  const environment = fixture(filename);
  let { database, index } = environment;
  try {
    const source = admit(database), other = admit(database, "separate stable source", "other");
    const vector = buildReady(environment);
    const vectorRows = () => database.connection.prepare("SELECT generation_id,window_id,hex(embedding_blob) AS embedding FROM source_index_vectors ORDER BY window_id").all();
    const before = vectorRows();
    let lifecycle = new SourceIndexLifecycle(index, fieldSha256);
    const first = await lifecycle.prepareLexical(WORKSPACE, "segmented-unicode61.v1", { ...limits, max_roots: 1 });
    expect(first).toMatchObject({ status: "partial", generation: { target_count: 2, completed_count: 1 } });
    expect(index.readLexicalCandidates(WORKSPACE, "部署", 8, queryBudget)).toMatchObject({ completion: "unavailable", reason: "lexical_generation_unpublished" });
    database.close({ optimize: false }); database = initDatabase({ filename });
    index = new SqliteSourceIndexRepository(database, fieldSha256);
    const repos = createDaemonFieldRepos({ database });
    Object.assign(environment, { database, index, records: repos.records, erase: repos.erase });
    lifecycle = new SourceIndexLifecycle(index, fieldSha256);
    const ready = await lifecycle.prepareLexical(WORKSPACE, "segmented-unicode61.v1", limits);
    expect(ready).toMatchObject({ status: "ready", generation: { generation_id: first.generation!.generation_id } });
    expect(vectorRows()).toEqual(before);
    expect(index.state(WORKSPACE)).toMatchObject({ active_generation_id: vector.generation.generation_id, status: "ready" });
    const target = index.readLexicalCandidates(WORKSPACE, "部署", 8, queryBudget).candidates[0]!.source;
    database.connection.prepare("UPDATE source_index_lexical_projections SET projection='corrupt' WHERE generation_id=? AND root_key=?")
      .run(ready.generation!.generation_id, target.root_key);
    expect(index.readLexicalCandidates(WORKSPACE, "部署", 8, queryBudget)).toMatchObject({ candidates: [], completion: "partial" });
    expect(await lifecycle.prepareLexical(WORKSPACE, "segmented-unicode61.v1", limits)).toMatchObject({ status: "ready" });
    expect(index.readLexicalCandidates(WORKSPACE, "部署", 8, queryBudget).candidates).toHaveLength(1);
    expect(vectorRows()).toEqual(before);
    database.connection.prepare("DELETE FROM source_index_lexical_projections WHERE generation_id=? AND root_key=?")
      .run(ready.generation!.generation_id, target.root_key);
    expect(index.readLexicalCandidates(WORKSPACE, "部署", 8, queryBudget)).toMatchObject({ candidates: [], completion: "partial" });
    expect(await lifecycle.prepareLexical(WORKSPACE, "segmented-unicode61.v1", limits)).toMatchObject({ status: "ready", analysis_units: body.length });
    expect(vectorRows()).toEqual(before);
    const selection = index.lexical.selectLexical(WORKSPACE, "raw-unicode61.v1");
    expect(index.lexical.writeLexicalDocument(WORKSPACE, ready.generation!.generation_id, target, body, BUDGET))
      .toMatchObject({ status: "rejected", reason: "superseded" });
    expect(index.readLexicalCandidates(WORKSPACE, "部署", 8, queryBudget)).toMatchObject({ completion: "unavailable" });
    expect(await lifecycle.prepareLexical(WORKSPACE, "raw-unicode61.v1", limits)).toMatchObject({ status: "ready", selection });
    expect(vectorRows()).toEqual(before);
    const resumed = await lifecycle.prepareLexical(WORKSPACE, "segmented-unicode61.v1", limits);
    admit(database, "replacement without searched word", "authored-deployment", "2");
    expect(index.lexical.writeLexicalDocument(WORKSPACE, resumed.generation!.generation_id, target, body, BUDGET))
      .toMatchObject({ status: "rejected", reason: "stale" });
    expect(index.readLexicalCandidates(WORKSPACE, "部署", 8, queryBudget).candidates).toEqual([]);
    expect(index.state(WORKSPACE)).toMatchObject({ active_generation_id: vector.generation.generation_id, status: "partial" });
    expect(vectorRows()).toEqual(before.filter(row => vector.documents.find(doc => doc.source.target.root_id === other.record.identity)!
      .windows.some(window => window.window_id === (row as { window_id: string }).window_id)));
    eraseSource(environment, source.record.identity);
    expect(database.connection.prepare("SELECT count(*) AS n FROM source_index_lexical_projections WHERE root_key=?").get(target.root_key)).toEqual({ n: 0 });
    expect(await lifecycle.prepareLexical(WORKSPACE, "segmented-unicode61.v1", limits)).toMatchObject({ status: "ready" });
  } finally { database.close({ optimize: false }); rmSync(directory, { recursive: true, force: true }); }
});
