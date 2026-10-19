import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sourceIndexProfileId, type SourceIndexProfile } from "@do-soul/alaya-protocol";
import { LocalOnnxEmbeddingClient } from "../../embedding-recall/local-onnx-embedding-client.js";
import { createForkLocalOnnxEmbeddingHost, type LocalOnnxEmbeddingIpcHost } from "../../embedding-recall/local-onnx-process/ipc-client.js";
import type { LocalOnnxEmbeddingIpcRequest, LocalOnnxEmbeddingIpcSuccess, LocalOnnxSourceResult } from "../../embedding-recall/local-onnx-process/protocol.js";
import { decodeLocalOnnxSourceResults } from "../../embedding-recall/local-onnx-process/vectors.js";
import type { SourceEmbeddingBinding, SourceEmbeddingInput } from "../../embedding-recall/source-embedding-runtime.js";

const stubChildPath = fileURLToPath(new URL("./local-onnx-embedding-ipc-stub-child.mjs", import.meta.url));
const clients: LocalOnnxEmbeddingClient[] = [];
const releaseTerminations: Array<() => void> = [];
afterEach(async () => {
  for (const release of releaseTerminations.splice(0)) release();
  await Promise.all(clients.splice(0).map(client => client.close()));
});

// Real fork/IPC and deterministic fixture evidence; no tokenizer, model, or provider execution.
describe("Source embedding (real fork transport, fixture capability)", () => {
  it("binds the child's profile and preserves raw input evidence with deterministic fixture vectors", async () => {
    const tracking = forkFixture();
    const client = openClient(tracking.host);
    const binding = await bind(client);
    expect(binding.profile).toMatchObject({ provider_kind: "local_onnx", model_id: client.modelId,
      model_revision: "fork-fixture-only", tokenizer_revision: "fork-fixture-tokenizer", dimensions: 384,
      window_bytes: 1024, max_input_tokens: 32 });
    expect(binding.profile_id).toBe(sourceIndexProfileId(binding.profile, sha256));
    const inputs = [{ input_id: "first", text: "  原文🙂\r\n " }, { input_id: "second", text: "another" }];
    const result = await binding.embedInputs(inputs, { profile_id: binding.profile_id, timeoutMs: 5_000 });
    expect(result).toHaveLength(2);
    for (const [index, row] of result.entries()) {
      expect(row).toMatchObject({ status: "embedded", input_id: inputs[index]!.input_id,
        input_digest: `sha256:${sha256(inputs[index]!.text)}`, token_count: 3, truncated: false });
      if (row.status !== "embedded") throw new Error("fixture must embed");
      expect(row.vector).toBeInstanceOf(Float32Array);
      expect([...row.vector]).toEqual(Array.from({ length: 384 }, (_, offset) => Math.fround(Math.sin(index + offset + 1) * 0.01)));
    }
    await expect(binding.embedInputs([], { profile_id: binding.profile_id, timeoutMs: 5_000 })).resolves.toEqual([]);
    await expect(client.embedTexts(["legacy"], { timeoutMs: 5_000 })).resolves.toHaveLength(1);
    expect(tracking.spawns).toBe(1);
  });

  it("snapshots bind options and caller inputs before asynchronous IPC", async () => {
    const tracking = forkFixture();
    const client = openClient(tracking.host);
    const options = { window_bytes: 1024, max_input_tokens: 32 };
    const pending = client.bindSourceEmbedding(options);
    options.window_bytes = 2048;
    options.max_input_tokens = 64;
    const binding = await pending;
    if (binding.status !== "ready") throw new Error("fixture must bind");
    expect(binding.profile.window_bytes).toBe(1024);
    expect(binding.profile.max_input_tokens).toBe(32);
    const inputs = [{ input_id: "original", text: "  raw🙂\r\n" }];
    const callOptions = { profile_id: binding.profile_id, timeoutMs: 5_000 };
    const result = binding.embedInputs(inputs, callOptions);
    inputs[0]!.input_id = "changed";
    inputs[0]!.text = "changed";
    inputs.push({ input_id: "extra", text: "extra" });
    callOptions.profile_id = "changed";
    await expect(result).resolves.toMatchObject([{ status: "embedded", input_id: "original", input_digest: `sha256:${sha256("  raw🙂\r\n")}` }]);
    expect(tracking.requests.find(request => request.op === "embed_source")?.inputs).toEqual([{ input_id: "original", text: "  raw🙂\r\n" }]);
  });

  it("returns an explicit refusal for a caller's mismatched profile without sending inference", async () => {
    const tracking = forkFixture();
    const binding = await bind(openClient(tracking.host));
    await expect(binding.embedInputs([{ input_id: "raw", text: "text" }], { profile_id: `sha256:${"b".repeat(64)}`, timeoutMs: 5_000 }))
      .resolves.toEqual([{ status: "not_embedded", input_id: "raw", input_digest: `sha256:${sha256("text")}`, token_count: null, reason: "profile_mismatch" }]);
    expect(tracking.requests.filter(request => request.op === "embed_source")).toHaveLength(0);
  });

  it.each(["missing", "unsupported"])("preserves a %s child Source capability as unsupported", async (kind) => {
    const tracking = forkFixture({ response(response, request) {
      if (request.op !== "bind_source") return;
      if (kind === "missing") delete response.sourceBinding;
      else response.sourceBinding = { status: "unsupported", reason: "fixture_no_tokenizer" };
    } });
    await expect(openClient(tracking.host).bindSourceEmbedding({ window_bytes: 1024 })).resolves.toEqual({ status: "unsupported",
      reason: kind === "missing" ? "child_source_evidence_unavailable" : "fixture_no_tokenizer" });
  });

  it.each(["profile digest", "model", "provider", "dimensions", "window", "token ceiling", "artifact digest"])("rejects a child's invalid bound %s", async (fault) => {
    const tracking = forkFixture({ response(response, request) {
      if (request.op !== "bind_source" || response.sourceBinding?.status !== "ready") return;
      const binding = response.sourceBinding;
      const profile = { ...binding.profile };
      if (fault === "profile digest") { response.sourceBinding = { ...binding, profile_id: `sha256:${"f".repeat(64)}` }; return; }
      if (fault === "model") profile.model_id = "wrong-model";
      if (fault === "provider") profile.provider_kind = "openai";
      if (fault === "dimensions") profile.dimensions = 383;
      if (fault === "window") profile.window_bytes = 2048;
      if (fault === "token ceiling") profile.max_input_tokens = 33;
      if (fault === "artifact digest") { response.sourceBinding = { ...binding, profile: { ...profile, artifact_digest: "not-a-digest" } }; return; }
      response.sourceBinding = { ...binding, profile, profile_id: sourceIndexProfileId(profile, sha256) };
    } });
    await expect(openClient(tracking.host).bindSourceEmbedding({ window_bytes: 1024, max_input_tokens: 32 }))
      .rejects.toThrow(/profile|digest|Invalid/i);
  });

  it.each(["input id", "input digest", "count", "dimensions", "NaN", "Infinity", "float32 overflow", "truncated", "token overflow", "fractional tokens", "status", "binding", "profile", "profile body"])("rejects invalid Source response evidence: %s", async (fault) => {
    const tracking = forkFixture({ response(response, request) {
      if (request.op !== "embed_source") return;
      if (fault === "count") { response.sourceResults = []; return; }
      if (fault === "binding" && response.sourceBinding?.status === "ready") { response.sourceBinding = { ...response.sourceBinding, binding_id: "old-binding" }; return; }
      if (fault === "profile" && response.sourceBinding?.status === "ready") { response.sourceBinding = { ...response.sourceBinding, profile_id: `sha256:${"b".repeat(64)}` }; return; }
      if (fault === "profile body" && response.sourceBinding?.status === "ready") {
        response.sourceBinding = { ...response.sourceBinding, profile: { ...response.sourceBinding.profile, tokenizer_revision: "changed" } }; return;
      }
      const row = response.sourceResults![0]!;
      if (row.status !== "embedded") throw new Error("fixture must embed");
      let mutated: unknown = { ...row };
      if (fault === "input id") mutated = { ...row, input_id: "other" };
      if (fault === "input digest") mutated = { ...row, input_digest: `sha256:${"f".repeat(64)}` };
      if (fault === "dimensions") mutated = { ...row, vector: [1, 0] };
      if (["NaN", "Infinity", "float32 overflow"].includes(fault)) mutated = { ...row, vector: [fault === "NaN" ? NaN : fault === "Infinity" ? Infinity : Number.MAX_VALUE, ...row.vector.slice(1)] };
      if (fault === "truncated") mutated = { ...row, truncated: true };
      if (fault === "token overflow") mutated = { ...row, token_count: 33 };
      if (fault === "fractional tokens") mutated = { ...row, token_count: 1.5 };
      if (fault === "status") mutated = { ...row, status: "ready" };
      response.sourceResults = [mutated as LocalOnnxSourceResult];
    } });
    const binding = await bind(openClient(tracking.host));
    await expect(binding.embedInputs([{ input_id: "input", text: "raw" }], { profile_id: binding.profile_id, timeoutMs: 5_000 }))
      .rejects.toThrow(/evidence|count|dimensions|finite|float32|attestation|binding|profile/i);
  });

  it("preserves explicit per-input refusal evidence instead of treating it as an empty successful batch", async () => {
    const tracking = forkFixture({ response(response, request) {
      if (request.op === "embed_source") response.sourceResults = request.inputs!.map(input => ({ status: "not_embedded",
        input_id: input.input_id, input_digest: `sha256:${sha256(input.text)}`, reason: "fixture_token_limit", token_count: 33 }));
    } });
    const binding = await bind(openClient(tracking.host));
    await expect(binding.embedInputs([{ input_id: "long", text: "raw" }], { profile_id: binding.profile_id, timeoutMs: 5_000 }))
      .resolves.toEqual([{ status: "not_embedded", input_id: "long", input_digest: `sha256:${sha256("raw")}`, reason: "fixture_token_limit", token_count: 33 }]);
  });

  it("rebinds only after replacement and refuses an old child-generation capability", async () => {
    const tracking = forkFixture();
    const client = openClient(tracking.host);
    const oldBinding = await bind(client);
    await expect(oldBinding.embedInputs([{ input_id: "hung", text: "__hang__" }], { profile_id: oldBinding.profile_id, timeoutMs: 40 }))
      .rejects.toThrow(/timed out/);
    const binding = await bind(client);
    expect(binding.profile_id).toBe(oldBinding.profile_id);
    expect(tracking.spawns).toBe(2);
    const oldId = tracking.requests.filter(request => request.op === "bind_source")[0]!.id;
    expect(tracking.replies.find(response => response.id === oldId)?.sourceBinding).not.toEqual(
      tracking.replies.filter(response => response.sourceBinding?.status === "ready").at(-1)?.sourceBinding);
    await expect(oldBinding.embedInputs([{ input_id: "stale", text: "raw" }], { profile_id: oldBinding.profile_id, timeoutMs: 5_000 }))
      .resolves.toMatchObject([{ status: "not_embedded", reason: "stale_child" }]);
    await expect(binding.embedInputs([{ input_id: "fresh", text: "raw" }], { profile_id: binding.profile_id, timeoutMs: 5_000 }))
      .resolves.toMatchObject([{ status: "embedded", input_id: "fresh" }]);
    expect(tracking.maxLive).toBe(1);
  });

  it("ignores an obsolete request id and a retired child's reply even when it uses the new request id", async () => {
    let staleResponse: LocalOnnxEmbeddingIpcSuccess | undefined;
    const tracking = forkFixture({
      response(response, request) { if (request.op === "embed_source") staleResponse ??= structuredClone(response); },
      send(request, childIndex) {
        if (request.op !== "embed_source" || !staleResponse) return;
        // The old id is invalid on the same child; the new id is invalid from the retired epoch.
        tracking.deliver[childIndex]!(structuredClone(staleResponse));
        if (childIndex > 0) tracking.deliver[0]!({ ...structuredClone(staleResponse), id: request.id });
      }
    });
    const client = openClient(tracking.host);
    const first = await bind(client);
    await first.embedInputs([{ input_id: "first", text: "raw" }], { profile_id: first.profile_id, timeoutMs: 5_000 });
    await expect(first.embedInputs([{ input_id: "second", text: "raw" }], { profile_id: first.profile_id, timeoutMs: 5_000 }))
      .resolves.toMatchObject([{ status: "embedded", input_id: "second" }]);
    await expect(client.embedTexts(["__hang__"], { timeoutMs: 40 })).rejects.toThrow(/timed out/);
    const next = await bind(client);
    await expect(next.embedInputs([{ input_id: "new-generation", text: "raw" }], { profile_id: next.profile_id, timeoutMs: 5_000 }))
      .resolves.toMatchObject([{ status: "embedded", input_id: "new-generation" }]);
  });

  it.each(["timeout", "abort"])("refuses Source %s and waits for the actual child exit before replacement", async (cancellation) => {
    let sent!: () => void;
    const started = new Promise<void>(resolve => { sent = resolve; });
    const tracking = forkFixture({ running: sent, holdTermination: true });
    const client = openClient(tracking.host);
    const binding = await bind(client);
    const controller = new AbortController();
    const pending = binding.embedInputs([{ input_id: "running", text: "__delay_exit__" }], {
      profile_id: binding.profile_id, timeoutMs: cancellation === "timeout" ? 100 : 5_000, signal: controller.signal
    });
    const refusal = expect(pending).rejects.toThrow(cancellation === "timeout" ? /timed out/ : /caller cancelled/);
    await started;
    if (cancellation === "abort") controller.abort(new Error("caller cancelled"));
    await refusal;
    expect(tracking.live).toBe(1);
    const replacement = bind(client);
    void replacement.catch(() => undefined); // Cleanup may reject it if an assertion fails.
    // Windows terminates immediately on SIGTERM, so hold the request at the host boundary.
    // The real exit event, rather than a sleep or a synthetic exit, releases the replacement.
    try {
      await new Promise(resolve => setImmediate(resolve));
      expect(tracking.spawns).toBe(1);
    } finally { tracking.releaseTermination(); }
    const fresh = await replacement;
    await expect(fresh.embedInputs([{ input_id: "recovered", text: "raw" }], { profile_id: fresh.profile_id, timeoutMs: 5_000 }))
      .resolves.toMatchObject([{ status: "embedded", input_id: "recovered" }]);
    expect(tracking.maxLive).toBe(1);
  });
});

// These guards bound decoder allocations, not Node's earlier IPC deserialization.
describe("Source embedding result decoding", () => {
  const profile: SourceIndexProfile = {
    provider_kind: "local_onnx", model_id: "fixture-model", model_revision: "fixture-only",
    artifact_digest: `sha256:${"a".repeat(64)}`, tokenizer_revision: "fixture-tokenizer", dimensions: 384,
    preprocessing: "fixture-raw", normalization: "fixture-unit", max_input_tokens: 32,
    windowing: "utf8-byte-windows.v1", window_bytes: 1024
  };

  it.each([undefined, null, {}, { length: 0 }, "not-an-array"])("rejects a non-array evidence payload (%j)", (rows) => {
    expect(() => decodeLocalOnnxSourceResults(rows as Parameters<typeof decodeLocalOnnxSourceResults>[0], [], profile))
      .toThrow("Missing Source embedding evidence");
  });

  it.each([
    { condition: "too few results", inputCount: 2, rowCount: 1, code: "OBLIGATION_VIOLATION", message: "Source embedding result count mismatch" },
    { condition: "too many results", inputCount: 1, rowCount: 2, code: "OBLIGATION_VIOLATION", message: "Source embedding result count mismatch" },
    { condition: "oversized result count", inputCount: 64, rowCount: 65, code: "VALIDATION", message: "Source embedding batch exceeds 64 inputs" },
    { condition: "oversized input count", inputCount: 65, rowCount: 64, code: "VALIDATION", message: "Source embedding batch exceeds 64 inputs" },
    { condition: "equal oversized counts", inputCount: 65, rowCount: 65, code: "VALIDATION", message: "Source embedding batch exceeds 64 inputs" }
  ])("rejects $condition before accessing sparse rows or allocating decoded results", ({ inputCount, rowCount, code, message }) => {
    const readRow = vi.fn(() => { throw new Error("unexpected result row access"); });
    const readInput = vi.fn(() => { throw new Error("unexpected input row access"); });
    const rows = new Array<LocalOnnxSourceResult>(rowCount);
    const inputs = new Array<SourceEmbeddingInput>(inputCount);
    Object.defineProperty(rows, 0, { get: readRow });
    Object.defineProperty(inputs, 0, { get: readInput });
    const arrayFrom = vi.spyOn(Array, "from");
    const float32 = vi.spyOn(globalThis, "Float32Array");
    let failure: unknown;
    let arrayAllocations: number;
    let vectorAllocations: number;
    try {
      decodeLocalOnnxSourceResults(rows, inputs, profile);
    } catch (error) {
      failure = error;
    } finally {
      arrayAllocations = arrayFrom.mock.calls.length;
      vectorAllocations = float32.mock.calls.length;
      arrayFrom.mockRestore();
      float32.mockRestore();
    }
    expect(failure).toMatchObject({ name: "CoreError", code, message });
    expect(readRow).not.toHaveBeenCalled();
    expect(readInput).not.toHaveBeenCalled();
    expect(arrayAllocations).toBe(0);
    expect(vectorAllocations).toBe(0);
  });

  it("accepts a valid empty batch as distinct from missing evidence", () => {
    const decoded = decodeLocalOnnxSourceResults([], [], profile);
    expect(decoded).toEqual([]);
    expect(Object.isFrozen(decoded)).toBe(true);
  });

  it.each([1, 64])("preserves valid evidence at the token ceiling for %i inputs", (count) => {
    const inputs = Array.from({ length: count }, (_, index) => ({ input_id: `input-${index}`, text: "  原文🙂\r\n " }));
    const rows: LocalOnnxSourceResult[] = inputs.map((input, index) => ({
      status: "embedded", input_id: input.input_id, input_digest: `sha256:${sha256(input.text)}`,
      token_count: 32, truncated: false,
      vector: Array.from({ length: 384 }, (_, offset) => Math.sin(index + offset + 1) * 0.01)
    }));
    const decoded = decodeLocalOnnxSourceResults(rows, inputs, profile);
    expect(decoded).toHaveLength(count);
    expect(Object.isFrozen(decoded)).toBe(true);
    for (const [index, row] of decoded.entries()) {
      expect(row).toMatchObject({
        status: "embedded", input_id: inputs[index]!.input_id,
        input_digest: `sha256:${sha256(inputs[index]!.text)}`, token_count: 32, truncated: false
      });
      if (row.status !== "embedded") throw new Error("fixture must embed");
      expect(row.vector).toBeInstanceOf(Float32Array);
      expect([...row.vector]).toEqual(Array.from({ length: 384 }, (_, offset) => Math.fround(Math.sin(index + offset + 1) * 0.01)));
      expect(Object.isFrozen(row)).toBe(true);
    }
  });
});

type MutableResponse = { -readonly [K in keyof LocalOnnxEmbeddingIpcSuccess]: LocalOnnxEmbeddingIpcSuccess[K] };
function forkFixture(hooks: {
  response?(response: MutableResponse, request: LocalOnnxEmbeddingIpcRequest): void;
  send?(request: LocalOnnxEmbeddingIpcRequest, childIndex: number): void;
  running?(): void;
  holdTermination?: boolean;
} = {}) {
  const inner = createForkLocalOnnxEmbeddingHost(stubChildPath);
  let held = hooks.holdTermination ?? false;
  let terminate: (() => void) | undefined;
  const tracking = { releaseTermination() { held = false; terminate?.(); terminate = undefined; },
    spawns: 0, live: 0, maxLive: 0, requests: [] as LocalOnnxEmbeddingIpcRequest[],
    replies: [] as LocalOnnxEmbeddingIpcSuccess[], deliver: [] as Array<(message: unknown) => void>, host: null! as LocalOnnxEmbeddingIpcHost };
  if (held) releaseTerminations.push(tracking.releaseTermination);
  tracking.host = { spawn() {
    const childIndex = tracking.spawns++;
    tracking.maxLive = Math.max(tracking.maxLive, ++tracking.live);
    const child = inner.spawn();
    child.on("exit", () => { tracking.live -= 1; });
    return new Proxy(child, { get(target, property, receiver) {
      if (property === "kill") return (signal?: Parameters<typeof child.kill>[0]) => {
        if (!held) return target.kill(signal);
        terminate = () => { target.kill(signal); };
        return true;
      };
      if (property === "send") return (message: LocalOnnxEmbeddingIpcRequest, callback?: (error: Error | null) => void) => {
        tracking.requests.push(structuredClone(message));
        hooks.send?.(message, childIndex);
        return target.send(message, callback);
      };
      if (property === "on") return (event: string, listener: (message: unknown) => void) => {
        if (event !== "message") return Reflect.apply(target.on, target, [event, listener]);
        tracking.deliver[childIndex] = listener;
        return target.on("message", message => {
          if ((message as { fixture?: string }).fixture === "source_running") { hooks.running?.(); return; }
          const response = message as MutableResponse;
          const request = tracking.requests.find(request => request.id === response.id)!;
          if (response.ok === true) { hooks.response?.(response, request); tracking.replies.push(structuredClone(response)); }
          listener(response);
        });
      };
      return Reflect.get(target, property, receiver);
    } });
  } };
  return tracking;
}

function openClient(host: LocalOnnxEmbeddingIpcHost): LocalOnnxEmbeddingClient {
  const client = new LocalOnnxEmbeddingClient({ ipcHost: host });
  clients.push(client);
  return client;
}
async function bind(client: LocalOnnxEmbeddingClient): Promise<SourceEmbeddingBinding> {
  const binding = await client.bindSourceEmbedding({ window_bytes: 1024, max_input_tokens: 32 });
  if (binding.status !== "ready") throw new Error(`fixture did not bind: ${binding.reason}`);
  return binding;
}
function sha256(text: string): string { return createHash("sha256").update(text, "utf8").digest("hex"); }
