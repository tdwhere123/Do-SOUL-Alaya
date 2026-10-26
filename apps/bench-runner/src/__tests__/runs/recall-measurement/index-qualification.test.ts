import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => { isolation.restore(); });
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import { prepareSourceIndexDocument } from "@do-soul/alaya-protocol";
import { SqliteSourceIndexRepository, StorageDatabase } from "@do-soul/alaya-storage";
import { insertPreHostSourceRecord } from "./historical-source.test-support.js";
import { startBenchDaemon, type BenchDaemonHandle } from "../../../harness/daemon.js";
import { callMcpTool } from "../../../harness/daemon/runtime/daemon-mcp-support.js";
import { readCurrentExtractionAuthorityRevision } from "../../../runs/extraction/authority/inspection.js";
import { SemanticChainConfigSchema, withSemanticChainDaemon, readSemanticChainDaemonRestoration }
  from "../../../runs/recall-measurement/contract.js";
import { captureFrozenSourceIndexQualifications, frozenIndexMetadataMatchesNativeBinding,
  type FrozenSourceIndexQualifications, type FrozenSourceIndexQualificationPage } from "../../../runs/recall-measurement/index-qualification.js";
import { readSourceIndexRootQualification } from "../../../../../core-daemon/src/runtime/recall-read-worker/source-index-measurement.js";
import { checkpointAndCopyBenchDb } from "../../../runs/snapshot/materialize.js";
import { hashRegularFileNoFollow } from "../../../runs/snapshot/bound-file.js";
import { applyBaselineSql, currentSchemaVersion } from "../../../../../../packages/storage/src/__tests__/migrations/apply-baseline.js";
import { hashedOriginalRecord, seedWorkspaces } from "../../../../../../packages/storage/src/__tests__/repos/field/field-contract-fixture.js";
import { migrateLegacyPathRelationsToTemporalCandidate } from "../../../../../../packages/storage/src/sqlite/temporal-cutover-gate.js";
import { CLOCK, INDEX_BUDGET, WS, ORIGINAL, QUERY_BUDGET, SIMULATED_CONFIGURATION, withIndexedSources, type IndexFixture }
  from "../../../../../core-daemon/src/__tests__/runtime/recall/source-semantic-index-acquisition.test-support.js";

let nextSnapshot = 0;
function snapshotConfig(fixture: IndexFixture) {
  const snapshotPath = join(dirname(fixture.filename), `qualification-${nextSnapshot++}.sqlite`);
  checkpointAndCopyBenchDb(fixture.filename, snapshotPath, { keepLiveConnection: true });
  return sessionConfig(snapshotPath);
}
function sessionConfig(snapshotPath: string) {
  const root = dirname(snapshotPath);
  return SemanticChainConfigSchema.parse({ snapshot_path: snapshotPath, snapshot_sha256: hashRegularFileNoFollow(snapshotPath),
    implementation_revision: readCurrentExtractionAuthorityRevision(), interpretation_clock: CLOCK, workspace_id: WS, run_id: "qualification-run",
    query_workset: { contract: "source-semantic-proposal-workset-v3", kind: "query", model: "gemini-2.5-flash-lite",
      request_profile: "gemini-2.5-nonthinking-v1", provider_url: "http://127.0.0.1:9", items: [{ original_query: ORIGINAL }] },
    query_cache_root: join(root, "q-cache"), correspondence_cache_root: join(root, "c-cache"),
    max_output_tokens: 4096, discovery_page_cap: 1, correspondence_pair_cap: 0, access_policy: "query-conditioned-v1",
    authorized_scopes: { mode: "named", scopes: ["project"] }, output_byte_limit: 1_000_000, budget: QUERY_BUDGET });
}
async function expectNativeBinding(daemon: BenchDaemonHandle, frozen: FrozenSourceIndexQualifications) {
  const observed = await daemon.observeSourceSemantics!({}, () => callMcpTool(daemon.mcpClient, "soul.interpretation", {
    operation: "prepare_query", original_query: ORIGINAL, budget: QUERY_BUDGET,
    authorized_scopes: { mode: "named", scopes: ["project"] }, access_policy: "query-conditioned-v1" }));
  expect(observed.outcome.status).toBe("success");
  expect(observed.status).toBe("available");
  const binding = observed.observations.find(frame => frame.facts?.binding != null)?.facts?.binding;
  expect(binding).toBeDefined();
  expect(binding).toMatchObject({ workspace_id: WS, as_of: CLOCK });
  expect(frozenIndexMetadataMatchesNativeBinding(frozen, binding!.index)).toBe(true);
}

it("captures indexed, not-indexed, missing-vector and unbound facts from the live restored WAL snapshot", async () => {
  await withIndexedSources([{ id: "harbor", text: "Harbor was delayed.", vector: [1, 0, 0] },
    { id: "a-unindexed", text: "Not in the active index.", indexed: false }], async fixture => {
    const config = snapshotConfig(fixture), originalBytes = readFileSync(config.snapshot_path);
    await withSemanticChainDaemon(config, join(dirname(fixture.filename), "restored"), async daemon => {
      const owned = readSemanticChainDaemonRestoration(daemon);
      const database = new StorageDatabase(owned.databasePath, new BetterSqlite3(owned.databasePath));
      const repository = new SqliteSourceIndexRepository(database, fieldContractSha256);
      try {
        database.connection.pragma("wal_autocheckpoint = 0");
        const pages: FrozenSourceIndexQualificationPage[] = [];
        const capture = () => captureFrozenSourceIndexQualifications({ daemon, onPage: page => { pages.push(page); } });
        const frozen = capture();
        const dataDir = daemon.dataDir;
        try {
          Reflect.set(daemon, "dataDir", config.snapshot_path);
          expect(captureFrozenSourceIndexQualifications({ daemon, onPage: () => undefined })).toEqual(frozen);
        } finally { Reflect.set(daemon, "dataDir", dataDir); }
        expect(frozen).toMatchObject({ snapshot_identity: `sha256:${config.snapshot_sha256}`,
          roots: 2, source_census: "complete", index: { query_state: { status: "partial" } } });
        expect(pages.every(page => page.snapshot_identity === frozen.snapshot_identity && page.index_identity === frozen.index_identity)).toBe(true);
        expect(JSON.stringify({ frozen, pages })).not.toContain(owned.databasePath);
        expect(pages.find(page => page.qualification.source_id === "harbor")!.qualification).toMatchObject({
          currentness: "ready", lexical: { status: "ready", start_byte: 0, end_byte: 19 },
          vector: { generation_member: true, expected_windows: 1, capture: "complete",
            windows: [expect.objectContaining({ status: "ready", start_byte: 0, end_byte: 19 })] } });
        expect(pages.find(page => page.qualification.source_id === "a-unindexed")!.qualification).toMatchObject({
          status: "not_indexed", lexical: { status: "not_indexed" }, vector: { generation_member: false, status: "not_indexed" } });
        await expectNativeBinding(daemon, frozen);
        expect(() => captureFrozenSourceIndexQualifications({ daemon: { ...daemon }, onPage: () => undefined }))
          .toThrow(/restoration is not live or owned/);
        // Commit on another connection between pages: this capture must retain its original read snapshot.
        const concurrentPages: FrozenSourceIndexQualificationPage[] = [];
        const concurrent = captureFrozenSourceIndexQualifications({ daemon, onPage: page => {
          concurrentPages.push(page);
          if (concurrentPages.length === 1) database.connection.prepare("DELETE FROM source_index_vectors WHERE workspace_id=?").run(WS);
        } });
        expect(concurrent).toEqual(frozen);
        expect(concurrentPages).toEqual(pages);
        expect(statSync(`${owned.databasePath}-wal`).size).toBeGreaterThan(0);
        pages.length = 0;
        const missing = capture();
        expect(pages.find(page => page.qualification.source_id === "harbor")!.qualification.vector).toMatchObject({
          status: "partial", windows: [expect.objectContaining({ status: "not_indexed", reason: "vector_missing" })] });
        await expectNativeBinding(daemon, missing);
        repository.unbind(WS);
        pages.length = 0;
        const unbound = capture();
        expect(unbound.index).toMatchObject({ query_state: { status: "unbound", reason: "no_active_generation" },
          selection: { profile_id: fixture.selection.profile_id }, generation: null });
        await expectNativeBinding(daemon, unbound);
        const absent = database.connection.transaction(() => readSourceIndexRootQualification(
          database, fieldContractSha256, WS, "absent"))();
        expect(absent).toMatchObject({ status: "stale", currentness: "stale", reason: "missing_source" });
        expect(() => readSourceIndexRootQualification(database, fieldContractSha256, WS, "harbor")).toThrow(/frozen read transaction/);
      } finally { database.close({ optimize: false }); }
    }, { sourceSemanticObservations: true, embeddingStartupProbe: "omit" });
    expect(readFileSync(config.snapshot_path)).toEqual(originalBytes);
    expect(hashRegularFileNoFollow(config.snapshot_path)).toBe(config.snapshot_sha256);
  });
}, 60_000);

it("pages the authoritative stored manifest without treating a diagnostic window prefix as absent coverage", async () => {
  const text = "harbor ".repeat(40);
  await withIndexedSources([{ id: "harbor", text, vector: [1, 0, 0] }], async fixture => {
    const selection = fixture.lifecycle.select(WS, { ...SIMULATED_CONFIGURATION, revision: "small-window-fixture",
      profile: { ...SIMULATED_CONFIGURATION.profile, window_bytes: 4 } });
    const generation = fixture.lifecycle.begin(selection);
    fixture.lifecycle.capture(WS, generation.generation_id, 128, INDEX_BUDGET);
    const target = fixture.repository.listTargets(WS, generation.generation_id, null, 128)[0]!;
    const document = prepareSourceIndexDocument({ source: target, body: text, profile: selection.configuration.profile }, fieldContractSha256);
    expect(fixture.repository.writeDocument(WS, generation.generation_id, document, INDEX_BUDGET).status).toBe("accepted");
    for (const window of document.windows) expect(fixture.repository.writeVector(WS, generation.generation_id, {
      window_id: window.window_id, input_digest: window.content_digest, embedding: new Float32Array([1, 0, 0]),
      token_count: 2, truncated: false }, INDEX_BUDGET).status).toBe("accepted");
    expect(fixture.lifecycle.publish(WS, generation.generation_id).status).toBe("accepted");
    await withSemanticChainDaemon(snapshotConfig(fixture), join(dirname(fixture.filename), "restored"), async daemon => {
      const pages: FrozenSourceIndexQualificationPage[] = [];
      const captured = captureFrozenSourceIndexQualifications({ daemon, onPage: page => { pages.push(page); } });
      expect(captured.source_census).toBe("complete");
      expect(pages.length).toBeGreaterThan(1);
      expect(pages[0]!.qualification.vector.capture).toBe("partial");
      expect(pages.at(-1)!.qualification.vector.capture).toBe("complete");
      expect(pages.flatMap(page => page.qualification.vector.windows).map(window => window.window_id))
        .toEqual(document.windows.map(window => window.window_id));
      expect(pages.every(page => page.qualification.vector.windows.length <= 32)).toBe(true);
    }, { embeddingStartupProbe: "omit" });
  });
}, 60_000);

it("qualifies a genuine pre-index schema only after canonical restore/start and expires successful and failed sessions", async () => {
  const root = mkdtempSync(join(tmpdir(), "legacy-index-qualification-")), snapshotPath = join(root, "legacy.sqlite");
  let escaped: BenchDaemonHandle | undefined;
  try {
    const legacy = new StorageDatabase(snapshotPath, new BetterSqlite3(snapshotPath));
    try {
      // Reuse the migration fixtures' genuine schema prefix and verified temporal bootstrap, not table deletion.
      applyBaselineSql(legacy.connection, 20);
      migrateLegacyPathRelationsToTemporalCandidate(legacy.connection, { selectionRequired: false });
      legacy.connection.exec("CREATE TABLE schema_version(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
      const mark = legacy.connection.prepare("INSERT INTO schema_version VALUES (?, ?)");
      for (let version = 1; version <= 20; version++) mark.run(version, CLOCK);
      seedWorkspaces(legacy, [WS]);
      insertPreHostSourceRecord(legacy, {
        ...hashedOriginalRecord(WS, "Harbor was delayed.", "harbor"), speaker: "user", scope_class: "project" });
      expect(legacy.connection.prepare("SELECT name FROM sqlite_master WHERE name='source_index_epochs'").get()).toBeUndefined();
    } finally { legacy.close({ optimize: false }); }
    const config = sessionConfig(snapshotPath), originalBytes = readFileSync(snapshotPath);
    const headers: FrozenSourceIndexQualifications[] = [];
    for (const failure of [false, true]) {
      const operation = withSemanticChainDaemon(config, join(root, failure ? "failed" : "complete"), async daemon => {
        escaped = daemon;
        const owned = readSemanticChainDaemonRestoration(daemon);
        expect(owned).toMatchObject({ snapshotSha256: config.snapshot_sha256, workspaceId: WS });
        expect(owned.databasePath).not.toBe(snapshotPath);
        const connection = new BetterSqlite3(owned.databasePath, { readonly: true, fileMustExist: true });
        try {
          expect(connection.prepare("SELECT MAX(version) AS version FROM schema_version").get()).toEqual({ version: currentSchemaVersion() });
          expect(connection.prepare("SELECT name FROM sqlite_master WHERE name='source_index_epochs'").get())
            .toEqual({ name: "source_index_epochs" });
        } finally { connection.close(); }
        const pages: FrozenSourceIndexQualificationPage[] = [];
        const header = captureFrozenSourceIndexQualifications({ daemon, onPage: page => { pages.push(page); } });
        headers.push(header);
        expect(header).toMatchObject({ snapshot_identity: `sha256:${config.snapshot_sha256}`, roots: 1, pages: 1,
          source_census: "complete", index: { query_state: { status: "unknown", reason: "missing_selection" },
            selection: null, generation: null } });
        expect(pages[0]!.qualification).toMatchObject({ currentness: "ready", status: "not_indexed",
          lexical: { status: "not_indexed" }, vector: { status: "not_indexed", generation_member: null } });
        await expectNativeBinding(daemon, header);
        if (failure) throw new Error("authored body failure");
      }, { sourceSemanticObservations: true, embeddingStartupProbe: "omit" });
      if (failure) await expect(operation).rejects.toThrow("authored body failure");
      else await operation;
      expect(() => readSemanticChainDaemonRestoration(escaped!)).toThrow(/restoration is not live or owned/);
      expect(() => captureFrozenSourceIndexQualifications({ daemon: escaped!, onPage: () => undefined }))
        .toThrow(/restoration is not live or owned/);
      expect(readFileSync(snapshotPath)).toEqual(originalBytes);
      expect(hashRegularFileNoFollow(snapshotPath)).toBe(config.snapshot_sha256);
    }
    expect(headers[0]).toEqual(headers[1]);
    const foreign = await startBenchDaemon({ dataDirRoot: join(root, "foreign"), workspaceId: WS,
      embeddingMode: "disabled", embeddingStartupProbe: "omit" });
    try {
      expect(() => readSemanticChainDaemonRestoration(foreign)).toThrow(/restoration is not live or owned/);
      expect(() => captureFrozenSourceIndexQualifications({ daemon: foreign, onPage: () => undefined }))
        .toThrow(/restoration is not live or owned/);
    } finally { await foreign.shutdown(); }
    await expect(withSemanticChainDaemon({ ...config, snapshot_sha256: "0".repeat(64) }, join(root, "wrong-digest"),
      async () => { throw new Error("must not start"); })).rejects.toThrow(/snapshot changed/);
    const original = new BetterSqlite3(snapshotPath, { readonly: true, fileMustExist: true });
    try {
      expect(original.prepare("SELECT MAX(version) AS version FROM schema_version").get()).toEqual({ version: 20 });
      expect(original.prepare("SELECT name FROM sqlite_master WHERE name='source_index_epochs'").get()).toBeUndefined();
    } finally { original.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);
