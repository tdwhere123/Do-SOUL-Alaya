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
  SourceIndexBackfill,
  SourceIndexLifecycle,
  defaultLocalOnnxCacheDir,
  fieldContractSha256,
  type SourceEmbeddingInput,
  type SourceEmbeddingResult
} from "@do-soul/alaya-core";
import {
  hashContentDigest,
  sourceIndexProfileId,
  SourceIndexOperationError,
  type SourceIndexBackfillResult,
  type SourceIndexProfile
} from "@do-soul/alaya-protocol";
import { initDatabase, SqliteSourceIndexRepository } from "@do-soul/alaya-storage";
import { seedWorkspaces } from "../../../../../../packages/storage/src/__tests__/repos/field/field-contract-fixture.js";
import {
  BUDGET,
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
    const receipt = await producerFor(environment, bind).runPass();
    expect(receipt).toMatchObject({ status: "settled", reason: "pass_complete", binding: { status: "ready" } });
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
    const receipt = await producer.runPass();
    expect(receipt).toMatchObject({ status: "failed", reason: "labeled_inference_unavailable",
      resources: { model_inputs: 2, input_bytes: Buffer.byteLength("first source bodysecond source body") },
      accounting: "lower_bound", model_execution_work: "unknown" });
    expect(receipt.resources.work).toBeGreaterThan(0);
    expect(receipt.resources.native_bytes).toBeGreaterThan(0);
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

  it("retains a thrown binding failure reason instead of returning a settled pass", async () => {
    const environment = fileEnvironment();
    const receipt = await producerFor(environment, async () => { throw new Error("binding_transport_unavailable"); }).runPass();
    expect(receipt).toMatchObject({ status: "failed", reason: "binding_transport_unavailable", binding: { status: "not_run" },
      resources: { work: 0, native_bytes: 0, model_inputs: 0, input_bytes: 0 }, model_execution_work: "unknown" });
  });

  it("retains an unbind exception instead of masking it with unsupported binding", async () => {
    const environment = fileEnvironment();
    vi.spyOn(SqliteSourceIndexRepository.prototype, "unbind").mockImplementationOnce(() => { throw new Error("unbind_write_failed"); });
    const fail = vi.spyOn(SqliteSourceIndexRepository.prototype, "fail");
    const receipt = await producerFor(environment, async () => ({ status: "unsupported", reason: "runtime_missing" })).runPass();
    expect(receipt).toMatchObject({ status: "failed", reason: "unbind_write_failed", binding: { status: "unsupported" } });
    expect(fail).not.toHaveBeenCalled();
  });

  it("retains known native costs and the thrown failure reason from capture", async () => {
    const environment = fileEnvironment();
    publishSource(environment, "source body");
    vi.spyOn(SqliteSourceIndexRepository.prototype, "capturePage").mockImplementationOnce(() => {
      throw new SourceIndexOperationError(new Error("capture_page_unavailable"), { work: 17, native_bytes: 23 });
    });
    const receipt = await producerFor(environment, labeledBind().bind).runPass();
    expect(receipt).toMatchObject({ status: "failed", reason: "capture_page_unavailable", accounting: "lower_bound",
      resources: { work: 17, native_bytes: 23, model_inputs: 0, input_bytes: 0 }, model_execution_work: "unknown" });
  });

  it.each(["partial", "resource_exhausted", "token_limit", "unsupported", "stale", "superseded", "unbound", "cancelled", "deadline"] as const)(
    "retains returned %s and spent work without publishing or failing the generation", async status => {
      const environment = fileEnvironment();
      publishSource(environment, "source body");
      const result: SourceIndexBackfillResult = { status, reason: `bounded_${status}`, accepted_vectors: 0,
        resources: { work: 7, native_bytes: 11, native_accounting: "partial", sql_internal_work: "unknown",
          model_inputs_submitted: 2, model_input_bytes_submitted: 8, token_count_observed: 0,
          inputs_without_token_count: 2, model_execution_work: "unknown" } };
      vi.spyOn(SourceIndexBackfill.prototype, "step").mockResolvedValueOnce(result);
      const activate = vi.spyOn(SqliteSourceIndexRepository.prototype, "activate");
      const fail = vi.spyOn(SqliteSourceIndexRepository.prototype, "fail");
      const receipt = await producerFor(environment, labeledBind().bind).runPass();
      expect(receipt).toMatchObject({ status, reason: `bounded_${status}`,
        resources: { model_inputs: 2, input_bytes: 8 }, accounting: "lower_bound", model_execution_work: "unknown" });
      expect(receipt.resources.work).toBeGreaterThanOrEqual(7);
      expect(receipt.resources.native_bytes).toBeGreaterThanOrEqual(11);
      expect(activate).not.toHaveBeenCalledWith(WORKSPACE, expect.any(String));
      expect(fail).not.toHaveBeenCalled();
    }
  );

  it("resumes pending windows after interrupted backfill and file-backed reopen", async () => {
    const environment = fileEnvironment();
    publishSource(environment, "Alpha猫\nβeta!終");
    const first = labeledBind();
    const partial = await producerFor(environment, first.bind, { modelInputs: 1 }).runPass();
    expect(partial).toMatchObject({ status: "resource_exhausted", reason: "model_input_budget", resources: { model_inputs: 1 } });
    expect(environment.index.state(WORKSPACE)).toMatchObject({ active_generation_id: null });
    expect(environment.index.state(WORKSPACE).status).not.toBe("failed");
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
    const fail = vi.spyOn(SqliteSourceIndexRepository.prototype, "fail");
    const receipt = await producer.runPass();
    expect(receipt).toMatchObject({ status: "unsupported", reason: "labeled_local_runtime_missing" });
    expect(fail).not.toHaveBeenCalled();
    expect(environment.index.state(WORKSPACE)).toMatchObject({
      status: "unbound", active_generation_id: null
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
    expect(await producer.runPass()).toMatchObject({ status: "deadline", reason: "deadline_exceeded" });
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
    expect(await producer.runPass()).toMatchObject({ status: "partial", reason: "pending_targets" });
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
    expect(await producer.runPass()).toMatchObject({ status: "busy", reason: "producer_occupied" });
    expect(embedInputs).toHaveBeenCalledTimes(1);
    await producer.stop();
    expect(await running).toMatchObject({ status: "stopped", reason: "producer_stopped", resources: { model_inputs: 1 } });
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

  it("restricts one pass to remaining modelInputs without raising the constructor cap", async () => {
    const environment = fileEnvironment();
    for (let index = 0; index < 3; index++) publishSource(environment, `body-${index}`, `source-${index}`);
    const { bind, embedInputs } = labeledBind({ max_input_tokens: 32 });
    const producer = producerFor(environment, bind);
    expect(await producer.runPass({ modelInputs: 1 })).toMatchObject({
      status: "partial", reason: "pending_targets", resources: { model_inputs: 1 },
      limits: { modelInputs: 8 }
    });
    expect(embedInputs).toHaveBeenCalledTimes(1);
    expect(embedInputs.mock.calls[0]![0]).toHaveLength(1);
  });

  it("rejects invalid remaining allowances before occupying a pass", async () => {
    const environment = fileEnvironment();
    publishSource(environment, "body");
    const { bind, embedInputs } = labeledBind({ max_input_tokens: 32 });
    const producer = producerFor(environment, bind);
    await expect(producer.runPass({ modelInputs: -1 })).rejects.toThrow(/invalid Source producer pass remaining/u);
    await expect(producer.runPass({ modelInputs: 1.5 })).rejects.toThrow(/invalid Source producer pass remaining/u);
    await expect(producer.runPass({ modelInputs: Number.NaN })).rejects.toThrow(/invalid Source producer pass remaining/u);
    await expect(producer.runPass({ stepDeadlineMs: 1 } as never)).rejects.toThrow(/invalid Source producer pass remaining/u);
    expect(embedInputs).not.toHaveBeenCalled();
  });

  it("completes nine one-window sources across two constructor-capped passes", async () => {
    const environment = fileEnvironment();
    for (let index = 0; index < 9; index++) publishSource(environment, `Stone ${index}.`, `source-${index}`);
    const { bind, embedInputs } = labeledBind({ max_input_tokens: 32 });
    const producer = producerFor(environment, bind, { modelInputs: 8 });
    expect(await producer.runPass()).toMatchObject({ status: "partial" });
    expect(embedInputs.mock.calls.length).toBe(8);
    for (let pass = 0; pass < 4 && environment.index.state(WORKSPACE).status !== "ready"; pass++) {
      await producer.runPass();
    }
    expect(environment.index.state(WORKSPACE)).toMatchObject({ status: "ready" });
    expect(embedInputs.mock.calls.length).toBe(9);
  });

  it("walks sixteen already-complete roots with flat counts then embeds only the pending tail", async () => {
    const environment = fileEnvironment();
    for (let index = 0; index < 18; index++) {
      publishSource(environment, "Alpha uses tools.", `source-${index}`);
    }
    const { bind, embedInputs } = labeledBind({ max_input_tokens: 32 });
    const ready = await bind({ window_bytes: sourceIndexWindowBytes(32), max_input_tokens: 32 });
    expect(ready.status).toBe("ready");
    if (ready.status !== "ready") throw new Error("fixture bind required");
    const lifecycle = new SourceIndexLifecycle(environment.index, fieldSha256);
    const backfill = new SourceIndexBackfill(lifecycle);
    const selection = lifecycle.select(WORKSPACE, { revision: "source-index-local.v1", profile: ready.profile });
    const generation = lifecycle.begin(selection);
    lifecycle.capture(WORKSPACE, generation.generation_id, 32, BUDGET);
    const roots = environment.index.listTargets(WORKSPACE, generation.generation_id, null, 32);
    expect(roots).toHaveLength(18);
    const stepBudget = { work: 100_000, native_bytes: 16 * 1024 * 1024, model_inputs: 64, input_bytes: 1024 * 1024,
      max_body_bytes: 4 * 1024 * 1024 };
    const signal = new AbortController().signal;
    for (const root of roots.slice(0, 17)) {
      const result = await backfill.step({
        selection, generation_id: generation.generation_id, root_key: root.root_key, binding: ready,
        budget: stepBudget, deadline_ms: Date.now() + 60_000, signal
      });
      expect(result.status).toBe("root_complete");
    }
    expect(environment.index.generation(WORKSPACE, generation.generation_id)).toMatchObject({
      status: "building", target_count: 18, completed_count: 17, enumeration_complete: true
    });
    expect(environment.index.state(WORKSPACE).status).not.toBe("ready");
    const constructed = embedInputs.mock.calls.length;
    expect(constructed).toBe(17);
    const producer = producerFor(environment, bind);
    const first = await producer.runPass();
    expect(embedInputs.mock.calls.length).toBe(constructed);
    expect(environment.index.generation(WORKSPACE, generation.generation_id)).toMatchObject({
      completed_count: 17, target_count: 18, status: "building"
    });
    expect(first.status).toBe("partial");
    const second = await producer.runPass();
    expect(embedInputs.mock.calls.length).toBe(constructed + 1);
    expect(embedInputs.mock.calls.at(-1)?.[0]).toHaveLength(1);
    expect(second).toMatchObject({ status: "settled" });
    expect(environment.index.state(WORKSPACE)).toMatchObject({ status: "ready" });
  });
});
