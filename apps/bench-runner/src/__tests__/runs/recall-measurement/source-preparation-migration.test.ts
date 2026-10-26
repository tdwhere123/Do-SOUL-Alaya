import { afterAll, afterEach, expect, it, vi } from "vitest";
const boundary = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  const { installStrictProviderFreeBoundary } = await import("../../support/strict-provider-free-boundary.js");
  const safe = installProviderFreeBoundary(), environment = process.env;
  const strict = installStrictProviderFreeBoundary();
  // The real daemon snapshots absent credential keys and installs a synthetic local
  // request token. Secrets were removed before imports; keep transport/file denial.
  process.env = environment;
  return { safe, strict };
});
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import childProcess from "node:child_process";
import BetterSqlite3 from "better-sqlite3";
import { canonicalJson, sourceIndexConfigurationId, sourceIndexProfileId } from "@do-soul/alaya-protocol";
import { fieldContractSha256, LocalOnnxEmbeddingClient } from "@do-soul/alaya-core";
import { StorageDatabase, initDatabase, SqliteSourceIndexRepository } from "@do-soul/alaya-storage";
import { insertPreHostSourceRecord } from "./historical-source.test-support.js";
import { migrateLegacyPathRelationsToTemporalCandidate } from "../../../../../../packages/storage/src/sqlite/temporal-cutover-gate.js";
import { migrateRetainedSourceChunks } from "../../../../../../packages/storage/src/sqlite/retained-source-migration.js";
import { applyBaselineSql } from "../../../../../../packages/storage/src/__tests__/migrations/apply-baseline.js";
import { seedWorkspaces, hashedOriginalRecord } from "../../../../../../packages/storage/src/__tests__/repos/field/field-contract-fixture.js";
import { configuration, CLOCK, WORKSPACE } from "../../../../../../packages/storage/src/__tests__/repos/source-index/source-index-fixture.js";
import { SemanticChainConfigSchema, assertChainSnapshot, chainIdentity, readChainArtifact, writeChainArtifact } from "../../../runs/recall-measurement/contract.js";
import { readCurrentExtractionAuthorityRevision } from "../../../runs/extraction/authority/inspection.js";
import { inspectSemanticChainSourceIndex, prepareSemanticChainSourceIndex } from "../../../runs/recall-measurement/source-index-binding.js";
import { admitOrdinarySourceDelivery } from "../../../runs/recall-measurement/ordinary/ordinary-source-admission.js";
import { executeOrdinaryRecallEntry } from "../../../runs/recall-measurement/ordinary/ordinary-entry-execution.js";
import { hashRegularFileNoFollow } from "../../../runs/snapshot/bound-file.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  expect(boundary.safe.violations).toEqual([]);
  expect(boundary.strict.forbidden).toEqual([]);
});
afterAll(() => { boundary.strict.restore(); boundary.safe.restore(); });

async function historicalFixture() {
  const root = mkdtempSync(join(tmpdir(), "source-preparation-migration-")); roots.push(root);
  const snapshot = join(root, "historical.sqlite");
  const database = new StorageDatabase(snapshot, new BetterSqlite3(snapshot));
  applyBaselineSql(database.connection, 22);
  migrateLegacyPathRelationsToTemporalCandidate(database.connection, { selectionRequired: false });
  database.connection.exec("CREATE TABLE schema_version(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  for (let version = 1; version <= 22; version++) database.connection.prepare("INSERT INTO schema_version VALUES(?,?)").run(version, CLOCK);
  seedWorkspaces(database);
  const record = insertPreHostSourceRecord(database,
    hashedOriginalRecord(WORKSPACE, "Blue stone retained record.", "record-source"));
  const capsule = {
    object_id: "cccccccc-cccc-4ccc-8ccc-000000000202", object_kind: "evidence_capsule", schema_version: 1,
    lifecycle_state: "active", created_at: CLOCK, updated_at: CLOCK, created_by: "user_action",
    evidence_kind: "conversation_excerpt", semantic_anchor: { topic: "stone", keywords: ["stone"], summary: "stone" },
    event_anchor: null, physical_anchor: null, evidence_health_state: "verified", gist: "short gist",
    excerpt: "Blue stone standalone capsule.", source_hash: null, run_id: "run-1", workspace_id: WORKSPACE, surface_id: null
  };
  // Preserve the schema-22 capsule shape rather than invoking the current provenance-aware writer.
  database.connection.prepare(`INSERT INTO evidence_capsules (object_id, created_at, updated_at, created_by,
    evidence_kind, semantic_anchor, evidence_health_state, gist, excerpt, run_id, workspace_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(capsule.object_id, capsule.created_at, capsule.updated_at, capsule.created_by,
      capsule.evidence_kind, canonicalJson(capsule.semantic_anchor), capsule.evidence_health_state,
      capsule.gist, capsule.excerpt, capsule.run_id, capsule.workspace_id);
  migrateRetainedSourceChunks(database.connection);
  const indexConfig = configuration({ provider_kind: "local_onnx", model_id: "fixture-local-model", window_bytes: 504, max_input_tokens: 512 });
  const configId = sourceIndexConfigurationId(indexConfig, fieldContractSha256);
  const profileId = sourceIndexProfileId(indexConfig.profile, fieldContractSha256);
  const oldId = `sha256:${fieldContractSha256(canonicalJson(["source-index-generation.v1", WORKSPACE, 1, configId, 0]))}`;
  database.connection.prepare("INSERT INTO source_index_selections VALUES(?,?,?,?,?,?)")
    .run(WORKSPACE, 1, configId, profileId, canonicalJson(indexConfig), oldId);
  database.connection.prepare(`INSERT INTO source_index_generations(workspace_id,generation_id,selection_revision,config_id,profile_id,
    configuration_json,source_epoch,status,enumeration_complete,target_count,completed_count) VALUES(?,?,?,?,?,?,0,'ready',1,1,1)`)
    .run(WORKSPACE, oldId, 1, configId, profileId, canonicalJson(indexConfig));
  database.close({ optimize: false });
  const config = SemanticChainConfigSchema.parse({ snapshot_path: snapshot, snapshot_sha256: hashRegularFileNoFollow(snapshot),
    implementation_revision: readCurrentExtractionAuthorityRevision(), interpretation_clock: "2026-09-22T00:00:00.000Z",
    workspace_id: WORKSPACE, run_id: "run-1", query_workset: { contract: "source-semantic-proposal-workset-v3", kind: "query",
      model: "not-executed", provider_url: "https://example.invalid", request_profile: "gemini-3.1-minimal-v1",
      items: [{ original_query: "Blue stone" }] }, query_cache_root: join(root, "q-cache"), correspondence_cache_root: join(root, "c-cache"),
    max_output_tokens: 4096, discovery_page_cap: 1, correspondence_pair_cap: 0, access_policy: "query-conditioned-v1",
    authorized_scopes: { mode: "unrestricted" }, output_byte_limit: 1000000,
    budget: { schema_version: 1, work_units: 10000000, memory_bytes: 60000000, page_budget: 10000, finalization_reserve: 50000, min_envelope: 10 } });
  const execution = { cache_root: join(root, "fixture-cache"), model_id: indexConfig.profile.model_id };
  const preparationPath = join(root, "historical-receipt.json");
  writeChainArtifact(preparationPath, { fixture: "historical receipt; never native qualification" });
  const bound = { ...config, source_index: { ...execution, kind: "cached_local" as const,
    preparation_path: preparationPath, preparation_identity: chainIdentity(readChainArtifact(preparationPath)),
    index: { configuration: indexConfig, config_id: configId, profile_id: profileId, selection_revision: 1,
      generation_id: oldId, source_epoch: 0, status: "ready" as const, enumeration_complete: true, target_count: 1, completed_count: 1 } } };
  return { root, config, bound, execution, oldId, record, capsule };
}

it("rejects a real pre-expansion read-only snapshot before ordinary startup without changing its bytes", async () => {
  const { root, config, bound } = await historicalFixture();
  const fork = vi.spyOn(childProcess, "fork");
  const embed = vi.spyOn(LocalOnnxEmbeddingClient.prototype, "bindSourceEmbedding");
  expect(() => inspectSemanticChainSourceIndex(config.snapshot_path, WORKSPACE, config.budget)).toThrow(/preparation_revision/u);
  await expect(executeOrdinaryRecallEntry({ config: bound, root: join(root, "ordinary"),
    queries: [{ query_key: "a".repeat(64), original_query: "Blue stone" }] })).rejects.toThrow(/preparation_revision/u);
  expect(existsSync(join(root, "ordinary"))).toBe(false);
  expect(fork).not.toHaveBeenCalled(); expect(embed).not.toHaveBeenCalled();
  expect(hashRegularFileNoFollow(config.snapshot_path)).toBe(config.snapshot_sha256);
});

it("migrates only a private copy, retires historical selection, and prepares new record and capsule roots for ordinary capture", async () => {
  const { root, config, execution, oldId, record, capsule } = await historicalFixture();
  const migratedPath = join(root, "migration-only.sqlite"); copyFileSync(config.snapshot_path, migratedPath);
  const migrated = initDatabase({ filename: migratedPath });
  try {
    const index = new SqliteSourceIndexRepository(migrated, fieldContractSha256);
    expect(index.generation(WORKSPACE, oldId)).toMatchObject({ preparation_revision: 1, status: "retired", reason: "retained_root_universe_changed" });
    expect(index.state(WORKSPACE)).toMatchObject({ status: "unbound", active_generation_id: null });
    expect(index.activate(WORKSPACE, oldId)).toEqual({ status: "rejected", reason: "superseded" });
    expect(inspectSemanticChainSourceIndex(migratedPath, WORKSPACE, config.budget).complete).toBe(false);
  } finally { migrated.close(); }
  const fork = vi.spyOn(childProcess, "fork").mockImplementation(() => { throw new Error("fixture forbids model process"); });
  const embedded: string[] = [];
  vi.spyOn(LocalOnnxEmbeddingClient.prototype, "embedTexts").mockImplementation(async texts => texts.map(() => new Float32Array([0.6, 0.8, 0])));
  vi.spyOn(LocalOnnxEmbeddingClient.prototype, "bindSourceEmbedding").mockImplementation(async options => {
    const profile = configuration({ provider_kind: "local_onnx", model_id: execution.model_id, window_bytes: options.window_bytes, max_input_tokens: 512 }).profile;
    return { status: "ready", profile, profile_id: sourceIndexProfileId(profile, fieldContractSha256),
      embedInputs: async inputs => inputs.map(input => {
        embedded.push(input.text);
        return { status: "embedded" as const, input_id: input.input_id, input_digest: `sha256:${fieldContractSha256(input.text)}`,
          token_count: 6, truncated: false as const, vector: new Float32Array([0.6, 0.8, 0]) };
      }) };
  });
  const prepared = await prepareSemanticChainSourceIndex(config, execution, join(root, "current"), undefined,
    { maxPasses: 2, modelInputs: 4, work: 100000, nativeBytes: 16777216, inputBytes: 1048576, softElapsedMs: 60000 });
  expect(prepared.config, JSON.stringify(prepared.report)).not.toBeNull();
  if (prepared.config === null) throw new Error(JSON.stringify(prepared.report));
  expect(prepared.report).toMatchObject({ admission: "prepared_complete", input_snapshot_sha256: config.snapshot_sha256,
    index: { target_count: 2, completed_count: 2, status: "ready" } });
  expect(embedded).toEqual(expect.arrayContaining(["Blue stone retained record.", "Blue stone standalone capsule."]));
  expect(prepared.config.source_index!.index.generation_id).not.toBe(oldId);
  assertChainSnapshot(prepared.config);
  const sealed = new StorageDatabase(prepared.config.snapshot_path,
    new BetterSqlite3(prepared.config.snapshot_path, { readonly: true, fileMustExist: true }));
  try {
    const index = new SqliteSourceIndexRepository(sealed, fieldContractSha256), id = prepared.config.source_index!.index.generation_id;
    expect(index.generation(WORKSPACE, id)).toMatchObject({ preparation_revision: 2, status: "ready" });
    expect(index.listTargets(WORKSPACE, id, null, 10)).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: expect.objectContaining({ root_kind: "source_record", root_id: record.record_id }) }),
      expect.objectContaining({ source_id: null, target: expect.objectContaining({ root_kind: "evidence_capsule", root_id: capsule.object_id }) })
    ]));
  } finally { sealed.close({ optimize: false }); }
  const capture = await executeOrdinaryRecallEntry({ config: prepared.config, root: join(root, "ordinary"),
    queries: [{ query_key: "a".repeat(64), original_query: "Blue stone" }] });
  expect(capture.mapping).toMatchObject({ status: "mapped", max_results: 5, observed_slot_target: 10 });
  expect(capture.rows[0]!.pages.length).toBeGreaterThan(0);
  expect(capture.rows[0]!.pages[0]).toMatchObject({ observation: "observed" });
  expect(capture.consumer_model_calls).toBe(0);
  const admission = new StorageDatabase(prepared.config.snapshot_path,
    new BetterSqlite3(prepared.config.snapshot_path, { readonly: true, fileMustExist: true }));
  try {
    const results = capture.rows[0]!.pages.flatMap(page => page.output?.results ?? []);
    expect(results.some(result => result.target.kind === "source_evidence" && result.target.root_kind === "evidence_capsule")).toBe(true);
    for (const result of results) {
      const target = result.target;
      if (target.kind !== "source_evidence") continue;
      admitOrdinarySourceDelivery(admission, WORKSPACE, null, target, result);
      expect(() => admitOrdinarySourceDelivery(admission, WORKSPACE, null, target,
        { ...result, content_preview: "forged retained bytes" })).toThrow();
      if (target.root_kind === "evidence_capsule") {
        expect(() => admitOrdinarySourceDelivery(admission, WORKSPACE, ["project"], target, result)).toThrow(/outside authorized scopes/u);
        expect(() => admitOrdinarySourceDelivery(admission, WORKSPACE, null, { ...target, evidence_object_id: null })).toThrow(/identity changed/u);
        expect(() => admitOrdinarySourceDelivery(admission, WORKSPACE, null, { ...target, content_digest: `sha256:${"0".repeat(64)}` })).toThrow(/unavailable/u);
        expect(() => admitOrdinarySourceDelivery(admission, "another-workspace", null, target)).toThrow(/workspace changed/u);
      }
    }
  } finally { admission.close({ optimize: false }); }
  expect(readdirSync(join(root, "current")).some(name => name.startsWith("source-runtime-"))).toBe(false);
  expect(fork).not.toHaveBeenCalled();
  expect(hashRegularFileNoFollow(config.snapshot_path)).toBe(config.snapshot_sha256);
}, 120000);
