import { afterAll, expect, it, vi } from "vitest";
import type { SourceIndexConfiguration } from "@do-soul/alaya-protocol";
import type { SourceEmbeddingBinding, SourceEmbeddingResult } from "../../embedding-recall/source-embedding-runtime.js";

type GuardReport = {
  phase: string; pid: number; preload_specifier: string; exec_argv?: string[];
  configured_child_exec_argv?: string[]; credential_environment_count: number;
  transport_guards: string[]; violations: string[]; local_responses: number;
  observed_application_replies?: number;
};
type OfflineIsolation = {
  children: { pid: number; script: string; preload: string; exited: boolean; code: number | null; signal: string | null }[];
  childReports: GuardReport[];
  requests: { op: string; inputs: number }[];
  snapshot(): GuardReport;
  restore(): void;
};

const offline = await vi.hoisted(async () => {
  const { existsSync } = await import("node:fs");
  const { isAbsolute, join } = await import("node:path");
  const cacheDir = process.env.ALAYA_LOCAL_SOURCE_EMBEDDING_CACHE_DIR;
  const files = ["config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "onnx/model_quantized.onnx"];
  let skipReason: string | null = null;
  if (process.env.ALAYA_SOURCE_INDEX_BACKFILL_OFFLINE !== "1") {
    skipReason = "requires ALAYA_SOURCE_INDEX_BACKFILL_OFFLINE=1 (explicit bounded local inference authorization)";
  } else if (!cacheDir) {
    skipReason = "requires explicit ALAYA_LOCAL_SOURCE_EMBEDDING_CACHE_DIR; no implicit cache or download";
  } else if (!isAbsolute(cacheDir)) {
    throw new Error("Offline Source backfill requires an absolute explicit cache directory");
  } else if (!files.every(file => existsSync(join(cacheDir, "Xenova/paraphrase-multilingual-MiniLM-L12-v2", file)))) {
    skipReason = "explicit local cache is unavailable/incomplete; no download or alternate cache allowed";
  }
  if (skipReason !== null) {
    console.info(`[source-index-backfill-offline] SKIPPED: ${skipReason}`);
    return { cacheDir, files, isolation: null as OfflineIsolation | null };
  }
  if (!process.features.typescript) throw new Error("Cannot bind early child guard without Node native TypeScript loading");
  const preload = new URL("../embedding-recall/local-onnx-source-embedding-offline-preload.mjs", import.meta.url).href;
  const { isolation } = await import(/* @vite-ignore */ preload);
  return { cacheDir, files, isolation: isolation as OfflineIsolation };
});

afterAll(() => offline.isolation?.restore());

function assertGuards(isolation: OfflineIsolation): void {
  const parent = isolation.snapshot();
  expect(parent.preload_specifier).toBe(isolation.children[0]!.preload);
  expect(parent.configured_child_exec_argv).toEqual(["--import", isolation.children[0]!.preload]);
  expect(parent.credential_environment_count).toBe(0);
  expect(parent.violations).toEqual([]);
  expect(isolation.children).toHaveLength(1);
  expect(isolation.children[0]!.exited).toBe(true);
  expect(isolation.childReports[0]?.phase, "actual child must acknowledge preload before entry imports").toBe("installed");
  for (const report of isolation.childReports) {
    const argv = report.exec_argv ?? [];
    expect(report.pid).toBe(isolation.children[0]!.pid);
    expect(report.preload_specifier).toBe(isolation.children[0]!.preload);
    expect(argv.includes("--import")).toBe(true);
    expect(argv[argv.indexOf("--import") + 1]).toBe(report.preload_specifier);
    expect(report.credential_environment_count).toBe(0);
    expect(report.transport_guards).toEqual(parent.transport_guards);
    expect(report.violations).toEqual([]);
  }
  expect(isolation.childReports.at(-1)?.phase).toBe("application_response");
}

function assertEmbedded(result: SourceEmbeddingResult): asserts result is Extract<SourceEmbeddingResult, { status: "embedded" }> {
  expect(result.status, `actual inference result for ${result.input_id}`).toBe("embedded");
  if (result.status !== "embedded") throw new Error(`Actual local inference refused: ${result.reason}`);
  expect(result.truncated).toBe(false);
  expect(result.vector).toBeInstanceOf(Float32Array);
  expect(result.vector.length).toBe(384);
  expect(result.vector.every(Number.isFinite)).toBe(true);
  const norm = Math.sqrt(result.vector.reduce((sum, value) => sum + value * value, 0));
  expect(norm).toBeGreaterThan(0);
  expect(Math.abs(norm - 1)).toBeLessThan(1e-5);
  expect(result.token_count).toBeGreaterThan(0);
}

// One authored 15-byte Source, two exact windows, two explicitly submitted short
// inference inputs and one production child. Hidden warmup model work is unknown.
it.skipIf(offline.isolation === null)("resumes cached native Source embeddings through SQLite without publishing the generation", {
  timeout: 240_000, retry: 0
}, async () => {
  const isolation = offline.isolation!;
  // Application imports and construction follow the shared early credential/transport guards.
  const { LocalOnnxEmbeddingClient } = await import("../../embedding-recall/local-onnx-embedding-client.js");
  const { SourceIndexBackfill } = await import("../../source-index/source-index-backfill.js");
  const { SourceIndexLifecycle } = await import("../../source-index/source-index-lifecycle.js");
  const { sourceIndexConfigurationId, sourceIndexProfileId } = await import("@do-soul/alaya-protocol");
  const { BUDGET, WORKSPACE, fieldPointer, fieldSha256, fixture, publishSource } =
    await import("../../../../storage/src/__tests__/repos/source-index/source-index-fixture.js");
  const { initDatabase } = await import("../../../../storage/src/sqlite/db.js");
  const { SqliteSourceIndexRepository } = await import("../../../../storage/src/repos/source-index/source-index-repo.js");
  const { createHash } = await import("node:crypto");
  const { mkdtempSync, rmSync, statSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const digest = (text: string) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
  const cacheMetadata = () => offline.files.map(file => {
    const { size, mtimeMs, ctimeMs, ino, mode } = statSync(join(offline.cacheDir!, "Xenova/paraphrase-multilingual-MiniLM-L12-v2", file));
    return { file, size, mtimeMs, ctimeMs, ino, mode };
  });
  const originalCache = cacheMetadata(); // Read-only observation; never chmod/copy into/mutate the cached model.
  const directory = mkdtempSync(join(tmpdir(), "source-index-backfill-offline-"));
  const filename = join(directory, "source.sqlite");
  const environment = fixture(filename);
  let database = environment.database;
  let index = environment.index;
  const client = new LocalOnnxEmbeddingClient({ cacheDir: offline.cacheDir! });
  try {
    const binding = await client.bindSourceEmbedding({ window_bytes: 8 });
    expect(binding.status, "loaded tokenizer/model provenance is required, not a vector-only provider").toBe("ready");
    if (binding.status !== "ready") throw new Error(`Actual Source binding unavailable: ${binding.reason}`);
    expect(binding.profile).toMatchObject({ provider_kind: "local_onnx", model_id: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
      dimensions: 384, window_bytes: 8, windowing: "utf8-byte-windows.v1" });
    expect(binding.profile.model_revision).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(binding.profile.artifact_digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(binding.profile.tokenizer_revision).toBe(binding.profile.artifact_digest);
    expect(binding.profile_id).toBe(sourceIndexProfileId(binding.profile, fieldSha256));
    expect(isolation.childReports[0]?.phase).toBe("installed");
    console.info("[source-index-backfill-offline] loaded", JSON.stringify({ profile_id: binding.profile_id, profile: binding.profile }));

    const body = "Alpha猫\nβeta!";
    const source = publishSource(environment, body);
    expect(source.content_digest).toBe(digest(body));
    expect(source.source_representation).toEqual({ kind: "original_body" });
    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM source_records").get()).toEqual({ count: 1 });
    const field = fieldPointer(database);
    let lifecycle = new SourceIndexLifecycle(index, fieldSha256);
    // The selection uses the actual loaded profile unchanged; fixture vector/artifact identities are never used.
    const configuration: SourceIndexConfiguration = { revision: "local-onnx-offline-v1", profile: binding.profile };
    const selection = lifecycle.select(WORKSPACE, configuration);
    expect(selection.configuration).toEqual(configuration);
    expect(selection.profile_id).toBe(binding.profile_id);
    expect(selection.config_id).toBe(sourceIndexConfigurationId(configuration, fieldSha256));
    const generation = lifecycle.begin(selection);
    expect(lifecycle.capture(WORKSPACE, generation.generation_id, 8, BUDGET)).toMatchObject({ added: 1,
      generation: { enumeration_complete: true, target_count: 1, completed_count: 0 } });
    const targets = index.listTargets(WORKSPACE, generation.generation_id, null, 8);
    expect(targets).toHaveLength(1);
    const target = targets[0]!;
    expect(target).toMatchObject({ body_bytes: 15, source_id: source.source_id,
      target: { root_kind: "source_record", root_id: source.record_id, content_digest: digest(body) } });
    const expected = [
      { ordinal: 0, start_byte: 0, end_byte: 8, body: "Alpha猫" },
      { ordinal: 1, start_byte: 8, end_byte: 15, body: "\nβeta!" }
    ].map(window => ({ ...window, root_key: target.root_key, content_digest: digest(window.body),
      window_id: digest(JSON.stringify(["source-index-window.v1", target.root_key, binding.profile_id,
        window.start_byte, window.end_byte, digest(window.body)])) }));
    const observed: SourceEmbeddingResult[] = [];
    let submittedInputs = 0;
    const embedInputs = vi.fn<SourceEmbeddingBinding["embedInputs"]>(async (inputs, options) => {
      // Observation only: every result comes unchanged from the real bound production child.
      expect(submittedInputs + inputs.length, "no retry or additional model inputs authorized").toBeLessThanOrEqual(2);
      expect(inputs).toEqual([{ input_id: expected[submittedInputs]!.window_id, text: expected[submittedInputs]!.body }]);
      expect(options.profile_id).toBe(binding.profile_id);
      expect(database.connection.inTransaction).toBe(false);
      submittedInputs += inputs.length;
      const results = await binding.embedInputs(inputs, options);
      observed.push(...results);
      return results;
    });
    const observedBinding: SourceEmbeddingBinding = { ...binding, embedInputs };
    const input = { selection, generation_id: generation.generation_id, root_key: target.root_key, binding: observedBinding,
      budget: { ...BUDGET, model_inputs: 1, input_bytes: 15, max_body_bytes: 15 },
      signal: new AbortController().signal };
    const manifest = () => database.connection.prepare(`SELECT ordinal,start_byte,end_byte,body,content_digest,window_id,root_key
      FROM source_index_windows WHERE workspace_id=? AND generation_id=? ORDER BY ordinal`).all(WORKSPACE, generation.generation_id);
    const vectors = () => database.connection.prepare(`SELECT w.ordinal,v.window_id,v.root_key,v.dimensions,v.token_count,v.embedding_blob
      FROM source_index_vectors v JOIN source_index_windows w USING(workspace_id,generation_id,window_id)
      WHERE v.workspace_id=? AND v.generation_id=? ORDER BY w.ordinal`).all(WORKSPACE, generation.generation_id);
    const assertUnpublished = () => {
      expect(index.state(WORKSPACE)).toEqual({ status: "building", selection, active_generation_id: null });
      expect(database.connection.prepare("SELECT * FROM projection_generation_pointer WHERE workspace_id=?").get(WORKSPACE)).toEqual(field.pointer);
    };

    const first = await new SourceIndexBackfill(lifecycle).step({ ...input, deadline_ms: Date.now() + 120_000 });
    expect(first).toMatchObject({ status: "resource_exhausted", reason: "model_input_budget", accepted_vectors: 1,
      resources: { model_inputs_submitted: 1, model_input_bytes_submitted: 8, inputs_without_token_count: 0,
        native_accounting: "complete", sql_internal_work: "unknown", model_execution_work: "unknown" } });
    expect(observed).toHaveLength(1);
    assertEmbedded(observed[0]!);
    expect(first.resources.token_count_observed).toBe(observed[0]!.token_count);
    expect(embedInputs.mock.calls.map(([inputs]) => inputs.map(value => value.text))).toEqual([["Alpha猫"]]);
    expect(manifest()).toEqual(expected);
    const initialVectors = vectors();
    expect(initialVectors).toHaveLength(1);
    expect(index.generation(WORKSPACE, generation.generation_id)).toMatchObject({ status: "building", completed_count: 0, target_count: 1 });
    assertUnpublished();

    // A fresh repository/connection reads committed state, not a caller cursor or retained manifest.
    const oldConnection = database.connection;
    environment.database.close({ optimize: false });
    expect(environment.database.isClosed()).toBe(true);
    database = initDatabase({ filename });
    expect(database).not.toBe(environment.database);
    expect(database.connection).not.toBe(oldConnection);
    index = new SqliteSourceIndexRepository(database, fieldSha256);
    lifecycle = new SourceIndexLifecycle(index, fieldSha256);
    expect(index.generation(WORKSPACE, generation.generation_id)?.selection).toEqual(selection);
    expect(vectors()).toEqual(initialVectors);
    expect(manifest()).toEqual(expected);
    expect(lifecycle.pendingWindows(WORKSPACE, generation.generation_id, target.root_key, 2, BUDGET))
      .toMatchObject({ status: "ready", ordinals: [1] });
    const resumeCall = embedInputs.mock.calls.length;
    const resumed = await new SourceIndexBackfill(lifecycle).step({ ...input, deadline_ms: Date.now() + 120_000 });
    expect(resumed).toMatchObject({ status: "root_complete", reason: "no_pending_windows", accepted_vectors: 1,
      resources: { model_inputs_submitted: 1, model_input_bytes_submitted: 7, inputs_without_token_count: 0,
        native_accounting: "complete", sql_internal_work: "unknown", model_execution_work: "unknown" } });
    expect(embedInputs.mock.calls.slice(resumeCall).map(([inputs]) => inputs.map(value => value.text))).toEqual([["\nβeta!"]]);
    expect(observed).toHaveLength(2);
    assertEmbedded(observed[1]!);
    expect(resumed.resources.token_count_observed).toBe(observed[1]!.token_count);
    expect(submittedInputs).toBe(2);
    expect(vectors()[0]).toEqual(initialVectors[0]);
    expect(manifest()).toEqual(expected);
    const persisted = vectors();
    expect(persisted).toHaveLength(2);
    for (const [ordinal, result] of observed.entries()) {
      assertEmbedded(result);
      expect(result.input_id).toBe(expected[ordinal]!.window_id);
      expect(result.input_digest).toBe(expected[ordinal]!.content_digest);
      expect(result.token_count).toBeLessThanOrEqual(binding.profile.max_input_tokens);
      // Independent little-endian byte encoding of the actual returned vector, not a simulated numerical fixture.
      const blob = Buffer.alloc(384 * 4);
      result.vector.forEach((value, dimension) => blob.writeFloatLE(value, dimension * 4));
      expect(persisted[ordinal]).toEqual({ ordinal, window_id: result.input_id, root_key: target.root_key,
        dimensions: 384, token_count: result.token_count, embedding_blob: blob });
    }
    expect(database.connection.prepare(`SELECT root_key,content_digest,body_bytes,body FROM source_index_text
      WHERE workspace_id=?`).all(WORKSPACE)).toEqual([{ root_key: target.root_key, content_digest: digest(body), body_bytes: 15, body }]);
    expect(lifecycle.pendingWindows(WORKSPACE, generation.generation_id, target.root_key, 2, BUDGET))
      .toMatchObject({ status: "ready", ordinals: [] });
    expect(index.generation(WORKSPACE, generation.generation_id)).toMatchObject({ status: "building", enumeration_complete: true,
      target_count: 1, completed_count: 1, selection });
    assertUnpublished(); // root_complete is not explicit lifecycle.publish / activation.
    expect(isolation.requests).toEqual([{ op: "warmup", inputs: 0 }, { op: "bind_source", inputs: 0 },
      { op: "embed_source", inputs: 1 }, { op: "embed_source", inputs: 1 }]);
    console.info("[source-index-backfill-offline] persisted", JSON.stringify({ first, resumed, manifest: expected,
      evidence: observed.map(result => ({ input_id: result.input_id, input_digest: result.input_digest,
        token_count: result.token_count, dimensions: result.status === "embedded" ? result.vector.length : null })),
      first_vector_unchanged: true, reopened_sqlite: true, generation_status: "building", active_generation_id: null }));
  } finally {
    try { await client.close(); }
    finally {
      database.close({ optimize: false });
      environment.database.close({ optimize: false });
      rmSync(directory, { recursive: true, force: true });
      console.info("[source-index-backfill-offline] guards", JSON.stringify({ parent: isolation.snapshot(), children: isolation.children,
        child_checkpoints: isolation.childReports, ipc_requests: isolation.requests, source_count_limit: 1,
        source_bytes_limit: 15, explicitly_submitted_short_inference_inputs_limit: 2, native_model_call_count: "not instrumented" }));
      expect(cacheMetadata()).toEqual(originalCache);
      assertGuards(isolation);
    }
  }
});
