import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
vi.mock("../../../harness/daemon.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../../harness/daemon.js")>(), startBenchDaemon: vi.fn()
}));
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDatabase, SqliteSourceIndexRepository, SqliteFieldSourceRecordRepo } from "@do-soul/alaya-storage";
import { fieldContractSha256, type SourceEmbeddingResult } from "@do-soul/alaya-core";
import { hashSourceRecordId, sourceIndexProfileId } from "@do-soul/alaya-protocol";
import { startBenchDaemon } from "../../../harness/daemon.js";
import { hashRegularFileNoFollow } from "../../../runs/snapshot/bound-file.js";
import { readCurrentExtractionAuthorityRevision } from "../../../runs/extraction/authority/inspection.js";
import { parseSemanticProposalWorkset } from "../../../runs/semantic-proposal/workset.js";
import { SemanticChainConfigSchema, assertChainSnapshot, readChainArtifact, withSemanticChainDaemon } from "../../../runs/semantic-chain/contract.js";
import { inspectSemanticChainSourceIndex, prepareSemanticChainSourceIndex } from "../../../runs/semantic-chain/source-index-binding.js";
import { checkpointAndCopyBenchDb } from "../../../runs/snapshot/freeze/db-copy.js";
import { createSourceIndexProducer } from "../../../../../core-daemon/src/runtime/source-index/source-index-producer.js";
import { configuration, fixture, publishSource, WORKSPACE } from "../../../../../../packages/storage/src/__tests__/repos/source-index/source-index-fixture.js";
import { hashedOriginalRecord } from "../../../../../../packages/storage/src/__tests__/repos/field/field-contract-fixture.js";
const roots: string[] = [];
afterEach(() => {
  vi.clearAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  expect(isolation.violations).toEqual([]);
});
afterAll(() => isolation.restore());

function setup(empty = false) {
  const root = mkdtempSync(join(tmpdir(), "source-binding-")); roots.push(root);
  const snapshot = join(root, "input.sqlite");
  const environment = fixture(snapshot);
  if (!empty) {
    publishSource(environment, "Blue stone.");
    publishSource(environment, "Green leaf.", "source-b");
  }
  environment.database.close();
  const config = SemanticChainConfigSchema.parse({ snapshot_path: snapshot, snapshot_sha256: hashRegularFileNoFollow(snapshot),
    implementation_revision: readCurrentExtractionAuthorityRevision(), interpretation_clock: "2026-09-22T00:00:00.000Z",
    workspace_id: WORKSPACE, run_id: "source-binding-run",
    query_workset: parseSemanticProposalWorkset({ contract: "source-semantic-proposal-workset-v3", kind: "query",
      model: "gemini-2.5-flash-lite", request_profile: "gemini-2.5-nonthinking-v1", provider_url: "http://127.0.0.1:9",
      items: [{ original_query: "What color is the stone?" }] }),
    query_cache_root: join(root, "q-cache"), correspondence_cache_root: join(root, "c-cache"),
    max_output_tokens: 4096, discovery_page_cap: 1, correspondence_pair_cap: 0, access_policy: "query-conditioned-v1",
    authorized_scopes: { mode: "named", scopes: ["project"] }, output_byte_limit: 1_000_000,
    budget: { schema_version: 1, work_units: 10_000_000, memory_bytes: 60_000_000,
      page_budget: 10_000, finalization_reserve: 50_000, min_envelope: 10 } });
  return { root, config, execution: { cache_root: join(root, "model-cache"), model_id: "fixture-local-model" } };
}

function bindProducer(unsupported: boolean, modelInputs = 8, modelId = "fixture-local-model",
  fault?: "backfill_failed" | "token_limit" | "binding_failed") {
  const checkpoint = vi.fn(async () => undefined);
  vi.mocked(startBenchDaemon).mockImplementation(async options => {
    const database = initDatabase({ filename: join(options!.dataDirRoot!, "alaya.db") });
    let submitted = 0;
    const producer = createSourceIndexProducer({ database, warn: vi.fn(), limits: { modelInputs },
      bindSourceEmbedding: async input => {
        if (fault === "binding_failed") throw new Error("fixture_binding_transport_failed");
        if (unsupported) return { status: "unsupported", reason: "cached_model_unavailable" };
        // Deterministic fixture binding, not real-model evidence. The offline test owns native loading.
        const profile = configuration({ provider_kind: "local_onnx", model_id: modelId,
          window_bytes: input.window_bytes, max_input_tokens: input.max_input_tokens ?? 512 }).profile;
        return { status: "ready", profile, profile_id: sourceIndexProfileId(profile, fieldContractSha256),
          embedInputs: async (inputs): Promise<readonly SourceEmbeddingResult[]> => {
            submitted += inputs.length;
            if (fault === "backfill_failed" && submitted > 1) throw new Error("fixture_inference_unavailable");
            return inputs.map(row => fault === "token_limit"
              ? { status: "not_embedded", input_id: row.input_id, input_digest: `sha256:${fieldContractSha256(row.text)}`,
                reason: "input_token_limit", token_count: 513 }
              : { status: "embedded", input_id: row.input_id,
                input_digest: `sha256:${fieldContractSha256(row.text)}`, truncated: false, token_count: 4,
                vector: new Float32Array([0.6, 0.8, 0]) });
          } };
      } });
    const handle = { dataDir: options!.dataDirRoot!, runtime: { runSourceIndexPass: () => producer.runPass() },
      checkpointFieldProjection: checkpoint,
      shutdown: vi.fn(async () => { await producer.stop(); database.close(); }) };
    // This narrow fixture exercises the stage through the normal producer/SQLite, not MCP/runtime readiness.
    return handle as unknown as Awaited<ReturnType<typeof startBenchDaemon>>;
  });
  return checkpoint;
}

it("keeps standalone freeze closure and explicitly preserves the live SQLite owner when sealing", () => {
  const { root } = setup();
  const filename = join(root, "input.sqlite");
  const database = initDatabase({ filename });
  checkpointAndCopyBenchDb(filename, join(root, "live-copy.sqlite"), { keepLiveConnection: true });
  expect(database.isClosed()).toBe(false);
  expect(initDatabase({ filename })).toBe(database);
  expect(database.connection.prepare("SELECT count(*) AS total FROM source_records").get()).toEqual({ total: 2 });
  const sealedHash = hashRegularFileNoFollow(join(root, "live-copy.sqlite"));
  database.connection.exec("CREATE TABLE snapshot_lifetime_probe (value TEXT NOT NULL)");
  database.connection.prepare("INSERT INTO snapshot_lifetime_probe VALUES (?)").run("after seal");
  expect(hashRegularFileNoFollow(join(root, "live-copy.sqlite"))).toBe(sealedHash);
  checkpointAndCopyBenchDb(filename, join(root, "closed-copy.sqlite"));
  expect(database.isClosed()).toBe(true);
  expect(() => database.connection.prepare("SELECT 1")).toThrow();
  expect(hashRegularFileNoFollow(join(root, "live-copy.sqlite"))).toBe(sealedHash);
});

it("leaves the live connection with its owner when snapshot publication fails", () => {
  const { root } = setup();
  const filename = join(root, "input.sqlite");
  const database = initDatabase({ filename });
  const destination = join(root, "blocked-destination");
  mkdirSync(destination);
  try {
    expect(() => checkpointAndCopyBenchDb(filename, destination, { keepLiveConnection: true })).toThrow();
    expect(database.isClosed()).toBe(false);
    expect(initDatabase({ filename })).toBe(database);
    expect(database.connection.prepare("SELECT count(*) AS total FROM source_records").get()).toEqual({ total: 2 });
  } finally { database.close(); }
  expect(database.isClosed()).toBe(true);
});

it("does not turn unsupported local binding or an unfinished pass into an enabled config", async () => {
  const { root, config, execution } = setup();
  const unsupportedCheckpoint = bindProducer(true);
  const unsupported = await prepareSemanticChainSourceIndex(config, execution, join(root, "unsupported"));
  expect(unsupported.config).toBeNull();
  expect(unsupported.report).toMatchObject({ contract: "semantic-chain-source-preparation-failure-v1",
    reason: "cached_model_unavailable", setup: { status: "unsupported", reason: "cached_model_unavailable",
      binding: { status: "unsupported", reason: "cached_model_unavailable" }, resources: { model_inputs: 0 } } });
  expect(unsupportedCheckpoint).not.toHaveBeenCalled();
  const partialCheckpoint = bindProducer(false, 1);
  const partial = await prepareSemanticChainSourceIndex(config, execution, join(root, "partial"));
  expect(partial.config).toBeNull();
  expect(partial.report).toMatchObject({ contract: "semantic-chain-source-preparation-failure-v1",
    reason: "pending_targets", setup: { status: "partial", reason: "pending_targets",
      binding: { status: "ready" }, resources: { model_inputs: 1 } } });
  expect(partialCheckpoint).not.toHaveBeenCalled();
  for (const directory of ["unsupported", "partial"]) {
    expect(existsSync(join(root, directory, "source-index.sqlite"))).toBe(false);
    expect(existsSync(join(root, directory, "chain-config.json"))).toBe(false);
    expect(readChainArtifact(join(root, directory, "preparation.json"))).toEqual(directory === "partial" ? partial.report : unsupported.report);
  }
});

it.each([
  ["backfill_failed", "failed", "fixture_inference_unavailable", 2],
  ["token_limit", "token_limit", "input_token_limit", 1],
  ["binding_failed", "failed", "fixture_binding_transport_failed", 0]
] as const)("retains %s as a reasoned failure receipt without a checkpoint or sealed snapshot", async (fault, status, reason, modelInputs) => {
  const { root, config, execution } = setup();
  const checkpoint = bindProducer(false, 8, "fixture-local-model", fault);
  const output = join(root, "refused");
  const result = await prepareSemanticChainSourceIndex(config, execution, output);
  expect(result.config).toBeNull();
  expect(result.report).toMatchObject({ contract: "semantic-chain-source-preparation-failure-v1", reason,
    setup: { status, reason, resources: { model_inputs: modelInputs }, accounting: "lower_bound", model_execution_work: "unknown" } });
  if (modelInputs > 0) {
    expect(result.report.setup.resources.work).toBeGreaterThan(0);
    expect(result.report.setup.resources.native_bytes).toBeGreaterThan(0);
    expect(result.report.setup.resources.input_bytes).toBeGreaterThan(0);
  }
  expect(checkpoint).not.toHaveBeenCalled();
  expect(readChainArtifact(join(output, "preparation.json"))).toEqual(result.report);
  expect(result.report).not.toHaveProperty("snapshot_path");
  expect(result.report).not.toHaveProperty("admission");
  expect(existsSync(join(output, "source-index.sqlite"))).toBe(false);
  expect(existsSync(join(output, "chain-config.json"))).toBe(false);
});

it("binds actual activation, reopens it after shutdown, and rejects changed generation or setup receipt", async () => {
  const { root, config, execution } = setup();
  bindProducer(false);
  const enabled = await prepareSemanticChainSourceIndex(config, execution, join(root, "enabled"), async bound => {
    expect(inspectSemanticChainSourceIndex(bound.snapshot_path, WORKSPACE).index).toEqual(bound.source_index!.index);
  });
  expect(enabled.config).not.toBeNull();
  if (enabled.config === null) throw new Error("Fixture Source generation did not activate");
  assertChainSnapshot(enabled.config);
  expect(enabled.config.source_index!.index).toMatchObject({ status: "ready", target_count: 2, completed_count: 2 });
  expect(() => assertChainSnapshot({ ...enabled.config!, source_index: { ...enabled.config!.source_index!,
    index: { ...enabled.config!.source_index!.index, generation_id: `sha256:${"0".repeat(64)}` } } })).toThrow(/sealed active generation/u);
  expect(() => assertChainSnapshot({ ...enabled.config!, source_index: { ...enabled.config!.source_index!,
    preparation_identity: "0".repeat(64) } })).toThrow(/receipt changed/u);
  const live = initDatabase({ filename: enabled.config.snapshot_path });
  new SqliteSourceIndexRepository(live, fieldContractSha256).unbind(WORKSPACE);
  live.close();
  expect(() => assertChainSnapshot(enabled.config!)).toThrow(/snapshot changed/u);
});

it("omits only the ordinary startup probe for Source setup and restoration and retains shutdown", async () => {
  const { root, config, execution } = setup();
  bindProducer(false);
  const prepared = await prepareSemanticChainSourceIndex(config, execution, join(root, "enabled"));
  if (prepared.config === null) throw new Error("Fixture Source generation did not activate");
  expect(startBenchDaemon).toHaveBeenLastCalledWith(expect.objectContaining({
    embeddingMode: "env", embeddingProviderKind: "local_onnx", embeddingStartupProbe: "omit", cachedLocalEmbedding: execution
  }));
  const setupDaemon = await vi.mocked(startBenchDaemon).mock.results[0]!.value;
  expect(setupDaemon.shutdown).toHaveBeenCalledTimes(1);
  await withSemanticChainDaemon(prepared.config, join(root, "restored"), async daemon => {
    expect(startBenchDaemon).toHaveBeenLastCalledWith(expect.objectContaining({
      embeddingMode: "env", embeddingProviderKind: "local_onnx", embeddingStartupProbe: "omit", cachedLocalEmbedding: execution
    }));
    expect(daemon.shutdown).not.toHaveBeenCalled();
  });
  const restored = await vi.mocked(startBenchDaemon).mock.results[1]!.value;
  expect(restored.shutdown).toHaveBeenCalledTimes(1);
  await expect(withSemanticChainDaemon(prepared.config, join(root, "failed-consumer"), async () => {
    throw new Error("fixture_consumer_failed");
  })).rejects.toThrow("fixture_consumer_failed");
  const failed = await vi.mocked(startBenchDaemon).mock.results[2]!.value;
  expect(failed.shutdown).toHaveBeenCalledTimes(1);
  await withSemanticChainDaemon(config, join(root, "disabled"), async () => {
    const options = vi.mocked(startBenchDaemon).mock.calls[3]![0]!;
    expect(options.embeddingMode).toBe("disabled");
    expect(options).not.toHaveProperty("embeddingStartupProbe");
  });
});

it.each([false, true])("reuses a verified complete matching index without re-embedding, empty=%s", async empty => {
  const { root, config, execution } = setup(empty);
  const firstCheckpoint = bindProducer(false);
  const first = await prepareSemanticChainSourceIndex(config, execution, join(root, "first"));
  if (first.config === null) throw new Error("Fixture generation did not activate");
  expect(firstCheckpoint).toHaveBeenCalledTimes(1);
  const reusedCheckpoint = bindProducer(false, 0);
  const reused = await prepareSemanticChainSourceIndex({ ...first.config, source_index: undefined }, execution, join(root, "reused"));
  expect(reused.config?.source_index?.index).toEqual(first.config.source_index!.index);
  expect(reused.report).toMatchObject({ admission: "reused_complete", setup: { resources: { model_inputs: 0 } } });
  expect(reused.config!.source_index!.index.status).toBe(empty ? "valid_empty" : "ready");
  expect(reusedCheckpoint).toHaveBeenCalledTimes(1);
});

it.each(["new_source", "missing_vector"])("refuses an existing incomplete matching generation after %s", async cause => {
  const { root, config, execution } = setup();
  bindProducer(false);
  const first = await prepareSemanticChainSourceIndex(config, execution, join(root, "first"));
  if (first.config === null) throw new Error("Fixture generation did not activate");
  const database = initDatabase({ filename: first.config.snapshot_path });
  if (cause === "new_source") {
    const row = hashedOriginalRecord(WORKSPACE, "A later source.", "source-c");
    new SqliteFieldSourceRecordRepo(database, fieldContractSha256).insert({ ...row, record_id: hashSourceRecordId(row, fieldContractSha256) });
  } else database.connection.prepare("DELETE FROM source_index_vectors WHERE workspace_id=?").run(WORKSPACE);
  database.close();
  const stale = { ...first.config, source_index: undefined, snapshot_sha256: hashRegularFileNoFollow(first.config.snapshot_path) };
  bindProducer(false, 0);
  const result = await prepareSemanticChainSourceIndex(stale, execution, join(root, "stale"));
  expect(result.config).toBeNull();
  expect(result.report).toMatchObject({ contract: "semantic-chain-source-preparation-failure-v1",
    setup: { status: "partial" }, reason: cause === "new_source" ? "capture_incomplete" : "pending_targets" });
  expect(existsSync(join(root, "stale", "chain-config.json"))).toBe(false);
});

it("refuses a loaded profile whose actual model differs from the explicit execution model", async () => {
  const { root, config, execution } = setup();
  const checkpoint = bindProducer(false, 8, "different-fixture-model");
  const result = await prepareSemanticChainSourceIndex(config, execution, join(root, "different-model"));
  expect(result.config).toBeNull();
  expect(result.report).toMatchObject({ contract: "semantic-chain-source-preparation-failure-v1",
    reason: "source_profile_mismatch", setup: { status: "settled", binding: { status: "ready" } } });
  expect(checkpoint).not.toHaveBeenCalled();
  expect(existsSync(join(root, "different-model", "chain-config.json"))).toBe(false);
});

it("rejects output aliases into inputs and leaves disabled configuration unbound", async () => {
  const { root, config, execution } = setup();
  mkdirSync(execution.cache_root);
  await expect(prepareSemanticChainSourceIndex(config, execution, join(execution.cache_root, "output"))).rejects.toThrow(/overlaps/u);
  await expect(prepareSemanticChainSourceIndex(config, { ...execution, cache_root: "relative-cache" }, join(root, "output"))).rejects.toThrow();
  expect(config.source_index).toBeUndefined();
  expect(startBenchDaemon).not.toHaveBeenCalled();
  assertChainSnapshot(config);
});
