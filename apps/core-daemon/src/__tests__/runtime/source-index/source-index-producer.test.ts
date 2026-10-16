import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROVIDER_FREE_BOOTSTRAP = new URL(
  "../../../../../bench-runner/src/__tests__/support/provider-free-cli-bootstrap.mjs",
  import.meta.url
).href;
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import(
    "../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js"
  );
  const bootstrap = new URL(
    "../../../../../bench-runner/src/__tests__/support/provider-free-cli-bootstrap.mjs",
    import.meta.url
  ).href;
  const flag = `--import=${bootstrap}`;
  const current = process.env.NODE_OPTIONS ?? "";
  if (!current.includes(flag)) process.env.NODE_OPTIONS = `${current} ${flag}`.trim();
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => { isolation.restore(); });

import {
  DEFAULT_LOCAL_ONNX_MODEL_ID,
  SourceIndexAcquisition,
  defaultLocalOnnxCacheDir,
  fieldContractSha256,
  type SourceEmbeddingInput,
  type SourceEmbeddingResult
} from "@do-soul/alaya-core";
import {
  hashContentDigest,
  sourceIndexProfileId,
  type SourceIndexProfile
} from "@do-soul/alaya-protocol";
import { initDatabase, SqliteSourceIndexRepository } from "@do-soul/alaya-storage";
import { seedWorkspaces } from "../../../../../../packages/storage/src/__tests__/repos/field/field-contract-fixture.js";
import {
  WORKSPACE,
  eraseSource,
  fieldSha256,
  fixture,
  publishSource,
  type Fixture
} from "../../../../../../packages/storage/src/__tests__/repos/source-index/source-index-fixture.js";
import {
  createSourceIndexProducer,
  sourceIndexWindowBytes,
  type SourceIndexProducer,
  type SourceIndexProducerBind,
  type SourceIndexProducerLimits
} from "../../../runtime/source-index/source-index-producer.js";

const directories: string[] = [];
const environments: Fixture[] = [];
const producers: SourceIndexProducer[] = [];

afterEach(async () => {
  for (const producer of producers.splice(0)) await producer.stop();
  for (const environment of environments.splice(0)) {
    if (!environment.database.isClosed()) environment.database.close({ optimize: false });
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const CACHE_FILES = [
  "config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json",
  "onnx/model_quantized.onnx"
];
function productionLocalCacheAvailable(): boolean {
  const cacheDir = process.env.ALAYA_LOCAL_SOURCE_EMBEDDING_CACHE_DIR ?? defaultLocalOnnxCacheDir();
  return CACHE_FILES.every(file => existsSync(join(cacheDir, DEFAULT_LOCAL_ONNX_MODEL_ID, file)));
}
if (!productionLocalCacheAvailable()) {
  console.info("[source-index-producer] product-default NOT_CHECKED: cached local model unavailable");
}

expect(PROVIDER_FREE_BOOTSTRAP).toContain("provider-free-cli-bootstrap.mjs");

function fileEnvironment() {
  const directory = mkdtempSync(join(tmpdir(), "source-index-producer-"));
  directories.push(directory);
  const environment = fixture(join(directory, "index.sqlite"));
  environments.push(environment);
  return environment;
}

function reopen(environment: Fixture) {
  const filename = environment.database.filename;
  environment.database.close({ optimize: false });
  const database = initDatabase({ filename });
  const next = { database, index: new SqliteSourceIndexRepository(database, fieldSha256) };
  environments.push(next as Fixture);
  return next;
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function labeledProfile(options: { window_bytes: number; max_input_tokens?: number },
  changes: Partial<SourceIndexProfile> = {}): SourceIndexProfile {
  return {
    provider_kind: "local_onnx",
    model_id: "labeled-source-index-binding",
    model_revision: "fixture-only",
    artifact_digest: `sha256:${"a".repeat(64)}`,
    tokenizer_revision: "labeled-tokenizer",
    dimensions: 3,
    preprocessing: "labeled-raw",
    normalization: "labeled-none",
    windowing: "utf8-byte-windows.v1",
    ...changes,
    window_bytes: options.window_bytes,
    max_input_tokens: options.max_input_tokens ?? changes.max_input_tokens ?? 12
  };
}

function labeledBind(changes: Partial<SourceIndexProfile> = {},
  embed?: (inputs: readonly SourceEmbeddingInput[]) => Promise<readonly SourceEmbeddingResult[]>) {
  const embedInputs = vi.fn(async (inputs: readonly SourceEmbeddingInput[]) => {
    if (embed !== undefined) return embed(inputs);
    return inputs.map(input => ({
      status: "embedded" as const,
      input_id: input.input_id,
      input_digest: hashContentDigest(input.text, fieldContractSha256),
      vector: new Float32Array([0.6, 0.8, 0]),
      token_count: 2,
      truncated: false as const
    }));
  });
  const bind = vi.fn<SourceIndexProducerBind>(async (options) => {
    const profile = labeledProfile(options, changes);
    return {
      status: "ready" as const,
      profile,
      profile_id: sourceIndexProfileId(profile, fieldContractSha256),
      embedInputs
    };
  });
  return { bind, embedInputs };
}

function producerFor(environment: { readonly database: Fixture["database"] }, bind: SourceIndexProducerBind,
  limits: Partial<SourceIndexProducerLimits> = {}) {
  const producer = createSourceIndexProducer({
    database: environment.database,
    bindSourceEmbedding: bind,
    warn: vi.fn(),
    limits
  });
  producers.push(producer);
  return producer;
}

describe("daemon Source-index producer through file-backed SQLite", () => {
  it("publishes a generation that query state can read without a manual index fixture", async () => {
    const environment = fileEnvironment();
    publishSource(environment, "Alpha uses tools.");
    const { bind } = labeledBind({ max_input_tokens: 32 });
    await producerFor(environment, bind).runPass();
    const state = environment.index.state(WORKSPACE);
    expect(state).toMatchObject({
      status: "ready",
      active_generation_id: expect.any(String)
    });
    if (state.status === "unknown") throw new Error("producer must select a real profile");
    expect(state.selection.configuration.profile.window_bytes).toBe(sourceIndexWindowBytes(32));
    expect(state.selection.configuration.profile.window_bytes).not.toBe(4096);
    expect(bind.mock.calls.map(call => call[0].window_bytes)).toEqual([
      4, sourceIndexWindowBytes(32)
    ]);
    const prepared = await SourceIndexAcquisition.prepareQuery({
      navigation: "Alpha",
      selection: state.selection,
      bind,
      signal: new AbortController().signal,
      remainingMs: () => 5_000
    });
    expect(prepared).toMatchObject({
      vector: { status: "available", profile_id: state.selection.profile_id },
      receipt: { status: "ready" }
    });
    expect(environment.database.connection.inTransaction).toBe(false);
  });

  it("fails observable state after inference throws past an accepted vector and resumes without re-inferring it", async () => {
    const environment = fileEnvironment();
    publishSource(environment, "first source body", "source-a");
    publishSource(environment, "second source body", "source-b");
    let remainingSuccesses = 1;
    const { bind, embedInputs } = labeledBind({ max_input_tokens: 32 }, async (inputs) => {
      if (remainingSuccesses <= 0) throw new Error("labeled_inference_unavailable");
      remainingSuccesses--;
      return inputs.map(input => ({
        status: "embedded" as const,
        input_id: input.input_id,
        input_digest: hashContentDigest(input.text, fieldContractSha256),
        vector: new Float32Array([0.6, 0.8, 0]),
        token_count: 2,
        truncated: false as const
      }));
    });
    const warn = vi.fn();
    const producer = createSourceIndexProducer({
      database: environment.database,
      bindSourceEmbedding: bind,
      warn,
      limits: {}
    });
    producers.push(producer);
    await producer.runPass();
    const failed = environment.index.state(WORKSPACE);
    expect(failed).toMatchObject({ status: "failed", active_generation_id: null });
    if (failed.status === "unknown") throw new Error("failed generation must remain selected");
    expect(failed.status).not.toBe("unbound");
    expect(warn.mock.calls).toEqual([
      ["source index producer backfill failed", { workspace_id: WORKSPACE, reason: "labeled_inference_unavailable" }]
    ]);
    expect(embedInputs).toHaveBeenCalledTimes(2);
    const acceptedIds = embedInputs.mock.calls[0]![0].map(input => input.input_id);
    const failedAttemptIds = embedInputs.mock.calls[1]![0].map(input => input.input_id);
    expect(environment.database.connection.prepare(
      "SELECT count(*) AS n FROM source_index_vectors WHERE workspace_id=?").get(WORKSPACE)).toEqual({ n: 1 });
    remainingSuccesses = 8;
    await producer.runPass();
    const recovered = environment.index.state(WORKSPACE);
    expect(recovered).toMatchObject({ status: "ready" });
    if (recovered.status === "unknown" || recovered.active_generation_id === null) {
      throw new Error("resumed generation must activate");
    }
    const recoveredIds = embedInputs.mock.calls.slice(2).flatMap(call => call[0].map(input => input.input_id));
    expect(embedInputs).toHaveBeenCalledTimes(3);
    for (const id of acceptedIds) expect(recoveredIds).not.toContain(id);
    expect(recoveredIds).toEqual(failedAttemptIds);
    expect(environment.database.connection.prepare(
      "SELECT count(*) AS n FROM source_index_vectors WHERE workspace_id=?").get(WORKSPACE)).toEqual({ n: 2 });
  });

  it("resumes pending windows after interrupted backfill and file-backed reopen", async () => {
    const environment = fileEnvironment();
    publishSource(environment, "Alpha猫\nβeta!終");
    const first = labeledBind();
    await producerFor(environment, first.bind, { modelInputs: 1 }).runPass();
    expect(environment.index.state(WORKSPACE)).toMatchObject({ active_generation_id: null });
    expect(first.embedInputs).toHaveBeenCalledTimes(1);
    const reopened = reopen(environment);
    const second = labeledBind();
    await producerFor(reopened, second.bind).runPass();
    const resumed = reopened.index.state(WORKSPACE);
    expect(resumed).toMatchObject({ status: "ready" });
    expect(second.embedInputs.mock.calls.length).toBeGreaterThan(0);
    if (resumed.status === "unknown") throw new Error("resumed generation must be selected");
    const prepared = await SourceIndexAcquisition.prepareQuery({
      navigation: "Alpha",
      selection: resumed.selection,
      bind: second.bind,
      signal: new AbortController().signal,
      remainingMs: () => 5_000
    });
    expect(prepared.vector.status).toBe("available");
  });

  it("selects a replacement profile and unbinds the previous generation on config switch", async () => {
    const environment = fileEnvironment();
    publishSource(environment, "Alpha uses tools.");
    let artifact = "a".repeat(64);
    const { embedInputs } = labeledBind();
    const bind = vi.fn<SourceIndexProducerBind>(async (options) => {
      const profile = labeledProfile(options, {
        model_id: artifact.startsWith("a") ? "labeled-model-a" : "labeled-model-b",
        artifact_digest: `sha256:${artifact}`
      });
      return {
        status: "ready" as const,
        profile,
        profile_id: sourceIndexProfileId(profile, fieldContractSha256),
        embedInputs
      };
    });
    const producer = producerFor(environment, bind);
    await producer.runPass();
    const first = environment.index.state(WORKSPACE);
    if (first.status === "unknown" || first.active_generation_id === null) {
      throw new Error("first model must activate");
    }
    artifact = "b".repeat(64);
    await producer.runPass();
    const second = environment.index.state(WORKSPACE);
    if (second.status === "unknown") throw new Error("replacement must remain selected");
    expect(second.active_generation_id).not.toBe(first.active_generation_id);
    expect(second.selection.profile_id).not.toBe(first.selection.profile_id);
    expect(second.selection.configuration.profile.model_id).toBe("labeled-model-b");
    expect(second.status).toBe("ready");
  });

  it("unbinds an active generation when the replacement runtime is unsupported", async () => {
    const environment = fileEnvironment();
    publishSource(environment, "Alpha uses tools.");
    const ready = labeledBind({ max_input_tokens: 32 });
    let bind: SourceIndexProducerBind = ready.bind;
    const producer = producerFor(environment, (options) => bind(options));
    await producer.runPass();
    expect(environment.index.state(WORKSPACE)).toMatchObject({ status: "ready" });
    bind = async () => ({ status: "unsupported", reason: "labeled_local_runtime_missing" });
    await producer.runPass();
    expect(environment.index.state(WORKSPACE)).toMatchObject({
      active_generation_id: null
    });
    expect(environment.index.state(WORKSPACE).status).not.toBe("ready");
  });

  it.each(["mutation", "erase"] as const)("rebuilds after source %s without activating a stale generation", async (kind) => {
    const environment = fileEnvironment();
    const source = publishSource(environment, "Alpha uses tools.");
    const { bind } = labeledBind({ max_input_tokens: 32 });
    const producer = producerFor(environment, bind);
    await producer.runPass();
    const first = environment.index.state(WORKSPACE);
    if (first.status === "unknown" || first.active_generation_id === null) {
      throw new Error("initial generation must activate");
    }
    if (kind === "mutation") {
      publishSource(environment, "replacement current body", source.source_id, {
        source_version: "v2", recorded_at: "2026-09-22T00:00:00Z"
      });
    } else {
      eraseSource(environment, source.record_id);
    }
    await producer.runPass();
    const second = environment.index.state(WORKSPACE);
    if (kind === "erase") {
      expect(second).toMatchObject({ status: "valid_empty" });
      if (second.status === "unknown") throw new Error("empty generation must remain selected");
      expect(second.active_generation_id).not.toBe(first.active_generation_id);
    } else {
      expect(second).toMatchObject({ status: "ready" });
      if (second.status === "unknown") throw new Error("mutated generation must remain selected");
      expect(second.active_generation_id).not.toBe(first.active_generation_id);
    }
  });

  it("rotates all seventeen native workspaces through production, mutation and unsupported cleanup", async () => {
    const environment = fileEnvironment();
    const workspaceIds = Array.from({ length: 17 }, (_, i) => `rotation-${String(i).padStart(2, "0")}`);
    seedWorkspaces(environment.database, workspaceIds);
    for (const workspace_id of workspaceIds) publishSource(environment, "body", "source", { workspace_id });
    let binding: SourceIndexProducerBind = labeledBind({ max_input_tokens: 32 }).bind;
    const producer = producerFor(environment, options => binding(options));
    for (let pass = 0; pass < 6; pass++) await producer.runPass();
    const before = workspaceIds.map(id => environment.index.state(id));
    expect(before.map(state => state.status)).toEqual(Array(17).fill("ready"));
    for (const workspace_id of workspaceIds) publishSource(environment, "new body", "source", {
      workspace_id, source_version: "v2", recorded_at: "2026-10-20T00:00:00Z"
    });
    for (let pass = 0; pass < 6; pass++) await producer.runPass();
    workspaceIds.forEach((id, i) => {
      const state = environment.index.state(id), old = before[i]!;
      expect(state.status).toBe("ready");
      if (state.status === "unknown" || old.status === "unknown") throw new Error("real selections required");
      expect(state.active_generation_id).not.toBe(old.active_generation_id);
    });
    binding = async () => ({ status: "unsupported", reason: "runtime_missing" });
    for (let pass = 0; pass < 3; pass++) await producer.runPass();
    expect(workspaceIds.map(id => environment.index.state(id).status)).toEqual(Array(17).fill("unbound"));
    expect(environment.database.connection.prepare("SELECT count(*) AS n FROM source_index_selections WHERE active_generation_id IS NOT NULL").get())
      .toEqual({ n: 0 });
  });

  it("shares the model and capture allowances across pages and workspaces", async () => {
    const environment = fileEnvironment();
    publishSource(environment, "first", "a");
    publishSource(environment, "second", "b");
    publishSource(environment, "third", "a", { workspace_id: "workspace-2" });
    const { bind, embedInputs } = labeledBind({ max_input_tokens: 32 });
    const capture = vi.spyOn(SqliteSourceIndexRepository.prototype, "capturePage");
    const producer = producerFor(environment, bind, { capturePage: 1, maxCapturePages: 2, modelInputs: 1 });
    await producer.runPass();
    expect(capture).toHaveBeenCalledTimes(2);
    expect(capture.mock.calls[1]![3].work).toBeLessThan(capture.mock.calls[0]![3].work);
    expect(capture.mock.calls[1]![3].native_bytes).toBeLessThan(capture.mock.calls[0]![3].native_bytes);
    expect(embedInputs).toHaveBeenCalledTimes(1);
    expect(environment.index.state("workspace-2")).toEqual({ status: "unknown" });
    await producer.runPass();
    expect(environment.index.state("workspace-2").status).toBe("ready");
    expect(embedInputs).toHaveBeenCalledTimes(2);
  });

  it("debits actual native operations from one capture/backfill/workspace allowance", async () => {
    const environment = fileEnvironment();
    publishSource(environment, "first", "a");
    publishSource(environment, "second", "b");
    publishSource(environment, "third", "a", { workspace_id: "workspace-2" });
    const operations = [
      vi.spyOn(SqliteSourceIndexRepository.prototype, "capturePage"),
      vi.spyOn(SqliteSourceIndexRepository.prototype, "pendingWindows"),
      vi.spyOn(SqliteSourceIndexRepository.prototype, "readDocument"),
      vi.spyOn(SqliteSourceIndexRepository.prototype, "writeDocument"),
      vi.spyOn(SqliteSourceIndexRepository.prototype, "writeVector")
    ];
    const { bind, embedInputs } = labeledBind({ max_input_tokens: 32 });
    await producerFor(environment, bind, { capturePage: 1, work: 1000, nativeBytes: 1024 * 1024,
      modelInputs: 3, inputBytes: 64 }).runPass();
    let work = 0, bytes = 0;
    for (const operation of operations) for (const result of operation.mock.results) {
      if (result.type !== "return" || !("resources" in result.value)) throw new Error("expected guarded native result");
      work += result.value.resources.work;
      bytes += result.value.resources.native_bytes;
    }
    expect(work).toBeGreaterThan(0);
    expect(bytes).toBeGreaterThan(0);
    expect(work).toBeLessThanOrEqual(1000);
    expect(bytes).toBeLessThanOrEqual(1024 * 1024);
    expect(embedInputs).toHaveBeenCalledTimes(3);
    expect(environment.index.state(WORKSPACE).status).toBe("ready");
    expect(environment.index.state("workspace-2").status).toBe("ready");
  });

  it("bounds completed-target visits and resumes beyond a completed prefix", async () => {
    const environment = fileEnvironment();
    for (let i = 0; i < 5; i++) publishSource(environment, `body-${i}`, `source-${i}`);
    const { bind } = labeledBind({ max_input_tokens: 32 });
    const list = vi.spyOn(SqliteSourceIndexRepository.prototype, "listTargets");
    const producer = producerFor(environment, bind, { maxRootsPerPass: 2 });
    for (let pass = 0; pass < 3; pass++) {
      const calls = list.mock.calls.length;
      await producer.runPass();
      expect(list.mock.calls.length - calls).toBeLessThanOrEqual(3); // two targets plus an empty workspace probe
    }
    expect(environment.index.state(WORKSPACE).status).toBe("ready");
  });

  it("bounds a hung binding wait and keeps restart quarantined until it settles", async () => {
    const environment = fileEnvironment();
    const gate = deferred<Awaited<ReturnType<SourceIndexProducerBind>>>();
    const bind = vi.fn<SourceIndexProducerBind>(() => gate.promise);
    const producer = producerFor(environment, bind, { stepDeadlineMs: 20 });
    await producer.runPass();
    expect(bind).toHaveBeenCalledTimes(1);
    await producer.stop();
    producer.start();
    await producer.runPass();
    expect(bind).toHaveBeenCalledTimes(1);
    gate.resolve({ status: "unsupported", reason: "fixture_absent" });
    await new Promise(resolve => setImmediate(resolve));
    await producer.runPass();
    expect(bind).toHaveBeenCalledTimes(2);
  });

  it("leaves the workspace unbound when the local runtime is missing", async () => {
    const environment = fileEnvironment();
    publishSource(environment, "Alpha uses tools.");
    const bind = vi.fn<SourceIndexProducerBind>(async () => ({
      status: "unsupported", reason: "labeled_local_runtime_missing"
    }));
    await producerFor(environment, bind).runPass();
    expect(environment.index.state(WORKSPACE)).toEqual({ status: "unknown" });
    expect(bind).toHaveBeenCalled();
  });

  it("does not publish after a single root_complete while other roots remain", async () => {
    const environment = fileEnvironment();
    publishSource(environment, "first source body", "source-a");
    publishSource(environment, "second source body", "source-b");
    const { bind, embedInputs } = labeledBind({ max_input_tokens: 32 });
    const producer = producerFor(environment, bind, { maxRootsPerPass: 1 });
    await producer.runPass();
    const incomplete = environment.index.state(WORKSPACE);
    expect(incomplete.status).not.toBe("ready");
    if (incomplete.status !== "unknown") expect(incomplete.active_generation_id).toBeNull();
    expect(embedInputs).toHaveBeenCalledTimes(1);
    await producer.runPass();
    expect(environment.index.state(WORKSPACE)).toMatchObject({ status: "ready" });
  });

  it("stops waiting without releasing native occupancy, then rearms after settlement", async () => {
    const environment = fileEnvironment();
    publishSource(environment, "Alpha uses tools.");
    const gate = deferred();
    const started = deferred();
    const { bind, embedInputs } = labeledBind({ max_input_tokens: 32 }, async (inputs) => {
      started.resolve();
      await gate.promise;
      return inputs.map(input => ({
        status: "embedded" as const,
        input_id: input.input_id,
        input_digest: hashContentDigest(input.text, fieldContractSha256),
        vector: new Float32Array([0.6, 0.8, 0]),
        token_count: 2,
        truncated: false as const
      }));
    });
    const producer = producerFor(environment, bind);
    const running = producer.runPass();
    await started.promise;
    await producer.runPass();
    expect(embedInputs).toHaveBeenCalledTimes(1);
    await producer.stop();
    await running;
    await producer.runPass();
    producer.start();
    await producer.runPass();
    expect(embedInputs).toHaveBeenCalledTimes(1);
    expect(environment.index.state(WORKSPACE).status).not.toBe("ready");
    gate.resolve();
    await new Promise(resolve => setImmediate(resolve));
    // Rotation may first visit the other workspace; the next complete sweep must recover.
    for (let pass = 0; pass < 2; pass++) await producer.runPass();
    // The cancelled result was discarded; a fresh pass recovers the pending window.
    expect(embedInputs).toHaveBeenCalledTimes(2);
    expect(environment.index.state(WORKSPACE).status).toBe("ready");
  });
});
