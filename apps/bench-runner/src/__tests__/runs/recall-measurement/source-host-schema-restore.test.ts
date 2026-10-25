import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import BetterSqlite3 from "better-sqlite3";
import { canonicalJson, hashSourceRecordId, sourceIndexProfileId, SoulInterpretationResponseSchema, sourceSemanticAccessPhases,
  SOURCE_SEMANTIC_FIELD_LIBRARY_PROTOCOL_VERSION } from "@do-soul/alaya-protocol";
import { fieldContractSha256, LocalOnnxEmbeddingClient } from "@do-soul/alaya-core";
import { StorageDatabase, openReadOnlyDatabase, prepareIndexedRecallProjection, SqliteFieldSourceRecordRepo, SqliteFieldEraseBarrierRepo,
  SqliteSourceIndexRepository } from "@do-soul/alaya-storage";
import { migrateLegacyPathRelationsToTemporalCandidate } from "../../../../../../packages/storage/src/sqlite/temporal-cutover-gate.js";
import { migrateVerifiedProjectionBindKey } from "../../../../../../packages/storage/src/sqlite/temporal-verified-bind-key.js";
import { writeRetainedSourceChunks } from "../../../../../../packages/storage/src/repos/field/retained-source-chunks.js";
import { applyBaselineSql } from "../../../../../../packages/storage/src/__tests__/migrations/apply-baseline.js";
import { seedWorkspaces, hashedOriginalRecord } from "../../../../../../packages/storage/src/__tests__/repos/field/field-contract-fixture.js";
import { buildReady, configuration, CLOCK, WORKSPACE } from "../../../../../../packages/storage/src/__tests__/repos/source-index/source-index-fixture.js";
import { snapshotSourceIndex } from "../../longmemeval/recall-eval/workspace-slice-source-index-fixture.js";
import { startBenchDaemon } from "../../../harness/daemon.js";
import { settleActiveBenchDaemonTasks } from "../../../harness/daemon-task.js";
import { callMcpTool } from "../../../harness/daemon/runtime/daemon-mcp-support.js";
import { hashRegularFileNoFollow } from "../../../runs/snapshot/bound-file.js";
import { restoreSnapshotToDataDir } from "../../../runs/snapshot/materialize.js";
import { inspectSemanticChainSourceIndex } from "../../../runs/recall-measurement/source-index-binding.js";

const roots: string[] = [];
afterEach(async () => {
  await settleActiveBenchDaemonTasks(); vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  expect(isolation.violations).toEqual([]);
});
afterAll(() => isolation.restore());
const budget = { schema_version: 1 as const, work_units: 200_000, memory_bytes: 4_000_000,
  page_budget: 100_000, finalization_reserve: 10_000, min_envelope: 10 };

function preparedLegacySource(filename: string) {
  const database = new StorageDatabase(filename, new BetterSqlite3(filename));
  try {
    applyBaselineSql(database.connection, 23);
    migrateLegacyPathRelationsToTemporalCandidate(database.connection, { selectionRequired: false });
    migrateVerifiedProjectionBindKey(database.connection);
    database.connection.exec("CREATE TABLE schema_version(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    for (let version = 1; version <= 23; version++) database.connection.prepare("INSERT INTO schema_version VALUES(?,?)").run(version, CLOCK);
    seedWorkspaces(database);
    prepareIndexedRecallProjection(database);
    const draft = { ...hashedOriginalRecord(WORKSPACE, "Blue stone retained source.", "legacy-source"), scope_class: "project" as const };
    const record = { ...draft, record_id: hashSourceRecordId(draft, fieldContractSha256) };
    // Author an actual old-schema row: the current writer correctly refuses schema 23.
    database.connection.prepare(`INSERT INTO source_records (workspace_id, record_id, source_id, source_version,
      content_digest, evidence_object_id, recorded_at, event_time, valid_from, valid_to, operator_id, speaker,
      scope_class, attribution_context_json, source_representation_json, source_body, retained_content_bytes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(record.workspace_id, record.record_id, record.source_id, record.source_version, record.content_digest,
        record.evidence_object_id, record.recorded_at, record.event_time, record.valid_from, record.valid_to,
        record.operator_id, record.speaker, record.scope_class, canonicalJson(record.attribution_context),
        canonicalJson(record.source_representation), record.source_body, Buffer.byteLength(record.source_body!));
    writeRetainedSourceChunks(database, { workspaceId: WORKSPACE, kind: "source_record", rootId: record.record_id,
      revision: record.source_version, digest: record.content_digest }, record.source_body!);
    const index = new SqliteSourceIndexRepository(database, fieldContractSha256);
    const prepared = buildReady({ database, index, records: new SqliteFieldSourceRecordRepo(database, fieldContractSha256),
      erase: new SqliteFieldEraseBarrierRepo(database, fieldContractSha256) },
    configuration({ provider_kind: "local_onnx", model_id: "authored-no-model", window_bytes: 504, max_input_tokens: 512 }));
    return { record, generation: prepared.generation, indexRows: snapshotSourceIndex(database, WORKSPACE) };
  } finally { database.close({ optimize: false }); }
}

it("restores schema-23 source/index bytes into the current daemon without enriching or retiring the ready generation", async () => {
  const root = mkdtempSync(join(tmpdir(), "host-schema-restore-")); roots.push(root);
  const snapshot = join(root, "schema23.sqlite"), prepared = preparedLegacySource(snapshot);
  const originalHash = hashRegularFileNoFollow(snapshot);
  const before = inspectSemanticChainSourceIndex(snapshot, WORKSPACE, budget);
  expect(before.complete).toBe(true);
  const directory = join(root, "restored");
  restoreSnapshotToDataDir({ snapshotDbPath: snapshot, expectedSha256: originalHash, dataDirRoot: directory });
  const profile = prepared.generation.selection.configuration.profile;
  const bind = vi.spyOn(LocalOnnxEmbeddingClient.prototype, "bindSourceEmbedding").mockResolvedValue({
    status: "ready", profile, profile_id: sourceIndexProfileId(profile, fieldContractSha256),
    // Query-only authored vector; any accidental source re-preparation must fail.
    embedInputs: async inputs => inputs.map(input => {
      expect(input.role).toBe("query");
      return { status: "embedded" as const, input_id: input.input_id, input_digest: `sha256:${fieldContractSha256(input.text)}`,
        vector: new Float32Array([0.6, 0.8, 0]), token_count: 2, truncated: false as const };
    }) });
  const daemon = await startBenchDaemon({ dataDirRoot: directory, workspaceId: WORKSPACE, runId: "run-1",
    configDirectoryRoot: root, embeddingMode: "env", embeddingProviderKind: "local_onnx", embeddingStartupProbe: "omit",
    cachedLocalEmbedding: { cache_root: join(root, "unused-cache"), model_id: profile.model_id },
    gardenCompute: "disabled", sqliteWriteQueue: "disabled", fieldProjectionAdmissionMode: "explicit_checkpoint",
    sourceSemanticInterpretationClock: "2026-09-22T00:00:00.000Z" });
  try {
    const restored = join(directory, "alaya.db");
    expect(inspectSemanticChainSourceIndex(restored, WORKSPACE, budget)).toEqual(before);
    const database = openReadOnlyDatabase(restored);
    try {
      expect(database.connection.prepare("SELECT max(version) AS version FROM schema_version").get()).toEqual({ version: 24 });
      expect(snapshotSourceIndex(database, WORKSPACE)).toEqual(prepared.indexRows);
      const records = new SqliteFieldSourceRecordRepo(database, fieldContractSha256);
      expect(records.findById(WORKSPACE, prepared.record.record_id)).toEqual(prepared.record);
      expect(records.readHostInventory({ workspaceId: WORKSPACE, recordId: prepared.record.record_id,
        sourceVersion: prepared.record.source_version, contentDigest: prepared.record.content_digest,
        authorizedScopes: null, nativeByteLimit: 131072, workLimit: 262144, memoryLimit: 262144 }).status).toBe("unknown");
    } finally { database.close({ optimize: false }); }
    const response = SoulInterpretationResponseSchema.parse(await callMcpTool(daemon.mcpClient, "soul.interpretation", {
      operation: "prepare_query", original_query: "Blue stone", budget, authorized_scopes: { mode: "unrestricted" },
      access_policy: "query-conditioned-v1" }));
    if (response.operation !== "prepare_query" || response.access === undefined) throw new Error("worker acquisition receipt required");
    const state = sourceSemanticAccessPhases(response.access).acquisition.result?.vector.state;
    expect(state).toMatchObject({ status: "ready", binding: { generation_id: prepared.generation.generation_id } });
    const delivery = SoulInterpretationResponseSchema.parse(await callMcpTool(daemon.mcpClient, "soul.interpretation", {
      operation: "recall", accepts_unreviewed_conditional_results: true, original_query: "Blue stone",
      semantic_correspondences: [], authorized_scopes: { mode: "unrestricted" }, budget, output_byte_limit: 100_000 }));
    if (delivery.operation !== "recall" || delivery.protocol_version !== SOURCE_SEMANTIC_FIELD_LIBRARY_PROTOCOL_VERSION) {
      throw new Error("current field delivery required");
    }
    expect(delivery.results, JSON.stringify(delivery)).toHaveLength(1);
    expect(delivery.results[0]?.content_preview).toBe("Blue stone retained source.");
    expect(delivery.results[0]?.target).toMatchObject({ root_id: prepared.record.record_id,
      span: { content_start: 0, content_end: 27, content_complete: true } });
    expect(bind).toHaveBeenCalled();
    expect(inspectSemanticChainSourceIndex(restored, WORKSPACE, budget)).toEqual(before);
  } finally { await daemon.shutdown(); }
  expect(hashRegularFileNoFollow(snapshot)).toBe(originalHash);
});
