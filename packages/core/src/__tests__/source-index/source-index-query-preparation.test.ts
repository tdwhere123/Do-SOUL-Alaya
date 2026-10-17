import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SourceSemanticQueryPreparationSchema, sourceIndexConfigurationId, sourceIndexProfileId,
  type SourceIndexProfile, type SourceIndexSelection, type SourceSemanticQueryPreparation
} from "@do-soul/alaya-protocol";
import { SourceIndexAcquisition } from "../../source-index/source-index-acquisition.js";
import {
  sourceEmbeddingInputDigest, sourceEmbeddingSha256, type SourceEmbeddingBinding,
  type SourceEmbeddingBindingResult, type SourceEmbeddingInput, type SourceEmbeddingResult
} from "../../embedding-recall/source-embedding-runtime.js";

const NAVIGATION = "needle";
const DIGEST = sourceEmbeddingInputDigest(NAVIGATION);
const ZERO = `sha256:${"0".repeat(64)}`;
afterEach(() => { vi.restoreAllMocks(); });

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function profile(changes: Partial<SourceIndexProfile> = {}): SourceIndexProfile {
  return {
    provider_kind: "local_onnx", model_id: "simulated-fixed-axis-no-model", model_revision: "fixture-v1",
    artifact_digest: `sha256:${"a".repeat(64)}`, tokenizer_revision: "simulated-token-count-v1",
    dimensions: 3, preprocessing: "exact-utf8", normalization: "none", max_input_tokens: 32,
    windowing: "utf8-byte-windows.v1", window_bytes: 64, ...changes
  };
}
function selectionFor(value: SourceIndexProfile): SourceIndexSelection {
  const configuration = { revision: "simulated-query-preparation-v1", profile: value };
  return { workspace_id: "workspace-1", selection_revision: 1, configuration,
    profile_id: sourceIndexProfileId(value, sourceEmbeddingSha256),
    config_id: sourceIndexConfigurationId(configuration, sourceEmbeddingSha256) };
}
function embedded(inputs: readonly SourceEmbeddingInput[], vector = new Float32Array([0.6, 0.8, 0]),
  token_count = 2): SourceEmbeddingResult[] {
  return inputs.map(input => ({ status: "embedded", input_id: input.input_id,
    input_digest: sourceEmbeddingInputDigest(input.text), vector, token_count, truncated: false }));
}
function refused(inputs: readonly SourceEmbeddingInput[], reason: string, token_count: number | null): SourceEmbeddingResult[] {
  return inputs.map(input => ({ status: "not_embedded", input_id: input.input_id,
    input_digest: sourceEmbeddingInputDigest(input.text), reason, token_count }));
}
function readyBind(selected: SourceIndexSelection, embed: SourceEmbeddingBinding["embedInputs"],
  changes: Partial<SourceEmbeddingBinding> = {}): SourceEmbeddingBinding {
  return { status: "ready", profile: selected.configuration.profile, profile_id: selected.profile_id, embedInputs: embed, ...changes };
}
async function prepare(input: {
  navigation?: string; supplemental_navigation?: string; selection?: SourceIndexSelection | null; bind?: (options: {
    window_bytes: number; max_input_tokens?: number;
  }) => Promise<SourceEmbeddingBindingResult>; signal?: AbortSignal; remainingMs?: () => number;
}) {
  const selected = input.selection === undefined ? selectionFor(profile()) : input.selection;
  const bind = input.bind ?? (async () => readyBind(selected ?? selectionFor(profile()), async (rows, options) => {
    expect(options.profile_id).toBe((selected ?? selectionFor(profile())).profile_id);
    return embedded(rows);
  }));
  return SourceIndexAcquisition.prepareQuery({
    navigation: input.navigation ?? NAVIGATION, supplemental_navigation: input.supplemental_navigation, selection: selected, bind, signal: input.signal ?? new AbortController().signal,
    remainingMs: input.remainingMs ?? (() => 5_000)
  });
}
function expectReceipt(receipt: SourceSemanticQueryPreparation, expected: Record<string, unknown>) {
  expect(SourceSemanticQueryPreparationSchema.safeParse(receipt).success).toBe(true);
  expect(receipt.navigation_digest).toBe(DIGEST);
  expect(receipt.elapsed_ms).toEqual(expect.any(Number));
  expect(receipt.elapsed_ms!).toBeGreaterThanOrEqual(0);
  expect(receipt).toMatchObject(expected);
}

describe("simulated query-preparation adapters, no native inference", () => {
  it("captures one selection and binding for distinct original/hint vectors and retains failed hint submissions", async () => {
    const selected = selectionFor(profile()), originalSelection = structuredClone(selected);
    const embed = vi.fn(async (inputs: readonly SourceEmbeddingInput[]) => {
      if (inputs[0]?.text !== NAVIGATION) throw new Error("hint inference failed");
      // Mutation after the first await cannot retarget the hint's selected profile/configuration.
      Object.assign(selected, { profile_id: ZERO, config_id: ZERO });
      return embedded(inputs);
    });
    const bind = vi.fn(async () => readyBind(originalSelection, embed));
    const result = await prepare({ selection: selected, supplemental_navigation: "different navigation", bind });
    expect(bind).toHaveBeenCalledTimes(1);
    expect(embed.mock.calls.map(([inputs]) => inputs[0]?.text)).toEqual([NAVIGATION, "different navigation"]);
    expect(result.receipt).toMatchObject({ status: "ready", submitted_inputs: 1,
      selected: { profile_id: originalSelection.profile_id, config_id: originalSelection.config_id } });
    expect(result.supplemental?.receipt).toMatchObject({ status: "failed", submitted_inputs: 1,
      token_count: null, execution_work: "unknown", external_api_attempts: 0,
      navigation_digest: sourceEmbeddingInputDigest("different navigation"),
      selected: { profile_id: originalSelection.profile_id, config_id: originalSelection.config_id } });
    expect(result.vector.status).toBe("available");
    expect(result.supplemental?.vector.status).toBe("unavailable");
    const duplicate = await prepare({ supplemental_navigation: NAVIGATION });
    expect(duplicate.supplemental).toBeUndefined();
  });

  it("reports null/unbound selection without binding, submitting, or treating abort/deadline as the cause", async () => {
    const bind = vi.fn();
    const signal = AbortSignal.abort();
    const result = await prepare({ selection: null, bind, signal, remainingMs: () => 0 });
    expect(bind).not.toHaveBeenCalled();
    expect(result.vector).toEqual({ status: "unavailable", reason: "source_profile_unbound" });
    expectReceipt(result.receipt, { status: "unavailable", reason: "source_profile_unbound", selected: null,
      method: "not_run", submitted_inputs: 0, token_count: null, external_api_attempts: 0,
      binding_work: "not_run", execution_work: "not_run" });
  });

  it("rejects an exact configuration digest mismatch without binding", async () => {
    const selected = selectionFor(profile());
    const bind = vi.fn();
    const result = await prepare({ selection: { ...selected, config_id: ZERO }, bind });
    expect(bind).not.toHaveBeenCalled();
    expect(result.vector).toEqual({ status: "unavailable", reason: "selected_configuration_mismatch" });
    expectReceipt(result.receipt, { status: "unavailable", reason: "selected_configuration_mismatch", selected: null,
      method: "not_run", submitted_inputs: 0, token_count: null, external_api_attempts: 0, binding_work: "not_run" });
  });

  it("does not treat a captured profile-id mismatch as unbound absence", async () => {
    const selected = { ...selectionFor(profile()), profile_id: ZERO };
    const bind = vi.fn();
    const result = await prepare({ selection: selected, bind });
    expect(bind).not.toHaveBeenCalled();
    expect(result.vector).toEqual({ status: "unavailable", reason: "query_preparation_failed" });
    expectReceipt(result.receipt, { status: "failed", reason: "query_preparation_failed", selected: null,
      method: "not_run", submitted_inputs: 0, token_count: null, binding_work: "not_run" });
  });

  it.each([
    { label: "binding profile_id", binding: (selected: SourceIndexSelection, embed: SourceEmbeddingBinding["embedInputs"]) => {
      const other = selectionFor(profile({ model_id: "other-simulated-axis" }));
      return readyBind(selected, embed, { profile: other.configuration.profile, profile_id: other.profile_id });
    }, reason: "selected_profile_mismatch", status: "unavailable" as const },
    { label: "binding profile bytes under the claimed id", binding: (selected: SourceIndexSelection, embed: SourceEmbeddingBinding["embedInputs"]) =>
      readyBind(selected, embed, { profile: profile({ model_id: "other-simulated-axis" }) }),
    reason: "query_preparation_failed", status: "failed" as const }
  ])("rejects exact $label mismatch without submitting inputs", async expected => {
    const selected = selectionFor(profile());
    const embed = vi.fn(async (rows: readonly SourceEmbeddingInput[]) => embedded(rows));
    const bind = vi.fn(async () => expected.binding(selected, embed));
    const result = await prepare({ selection: selected, bind });
    expect(embed).not.toHaveBeenCalled();
    expect(result.vector).toEqual({ status: "unavailable", reason: expected.reason });
    expectReceipt(result.receipt, { status: expected.status, reason: expected.reason,
      selected: { config_id: selected.config_id, profile_id: selected.profile_id, profile: selected.configuration.profile },
      method: "not_run", submitted_inputs: 0, token_count: null, binding_work: "unknown",
      execution_work: "not_run", external_api_attempts: null });
  });

  it("captures selection before bind awaits and cannot retarget to a mutated profile", async () => {
    const selected = selectionFor(profile());
    const mutated = selectionFor(profile({ provider_kind: "opaque-remote-api", model_id: "mutated-axis",
      artifact_digest: `sha256:${"b".repeat(64)}` }));
    const embed = vi.fn(async (rows: readonly SourceEmbeddingInput[]) => embedded(rows));
    const opened = deferred(), release = deferred();
    const bind = vi.fn(async (options: { window_bytes: number; max_input_tokens?: number }) => {
      opened.resolve(); await release.promise;
      expect(options).toEqual({ window_bytes: 64, max_input_tokens: 32 });
      return readyBind(mutated, embed);
    });
    const pending = prepare({ selection: selected, bind });
    await opened.promise;
    const caller = selected as SourceIndexSelection & { profile_id: string; config_id: string;
      configuration: { profile: SourceIndexProfile } };
    Object.assign(caller.configuration.profile, { provider_kind: mutated.configuration.profile.provider_kind,
      model_id: mutated.configuration.profile.model_id, window_bytes: 4, max_input_tokens: 8 });
    caller.profile_id = mutated.profile_id;
    caller.config_id = mutated.config_id;
    release.resolve();
    const result = await pending;
    expect(embed).not.toHaveBeenCalled();
    expect(result.vector).toEqual({ status: "unavailable", reason: "selected_profile_mismatch" });
    expectReceipt(result.receipt, { status: "unavailable", reason: "selected_profile_mismatch",
      selected: { profile_id: selectionFor(profile()).profile_id, profile: profile() },
      method: "not_run", submitted_inputs: 0, binding_work: "unknown", external_api_attempts: null });
  });

  it.each([
    { label: "result count", embed: async (inputs: readonly SourceEmbeddingInput[]) => [...embedded(inputs), ...embedded(inputs)] },
    { label: "input digest", embed: async (inputs: readonly SourceEmbeddingInput[]) => embedded(inputs).map(row =>
      ({ ...row, input_digest: ZERO })) },
    { label: "token_count", embed: async (inputs: readonly SourceEmbeddingInput[]) => embedded(inputs, new Float32Array([1, 0, 0]), 0) },
    { label: "non-Float32 vector", embed: async (inputs: readonly SourceEmbeddingInput[]) => embedded(inputs).map(row =>
      ({ ...row, vector: [0.6, 0.8, 0] as unknown as Float32Array })) }
  ])("treats malformed $label as unknown tokens after a submitted input", async expected => {
    const embed = vi.fn(expected.embed);
    const result = await prepare({ bind: async () => readyBind(selectionFor(profile()), embed) });
    expect(embed).toHaveBeenCalledTimes(1);
    expect(result.vector).toEqual({ status: "unavailable", reason: "query_preparation_failed" });
    expectReceipt(result.receipt, { status: "failed", reason: "query_preparation_failed", method: "local_inference",
      submitted_inputs: 1, token_count: null, execution_work: "unknown", external_api_attempts: 0 });
  });

  it("records observed tokens for a zero vector and for a refused input, not for a thrown embed", async () => {
    const zero = new Float32Array([0, 0, 0]);
    const zeros = await prepare({ bind: async () => readyBind(selectionFor(profile()),
      async inputs => embedded(inputs, zero, 4)) });
    expect(zeros.vector).toEqual({ status: "unavailable", reason: "zero_query_vector" });
    expect("embedding" in zeros.vector).toBe(false);
    expectReceipt(zeros.receipt, { status: "failed", reason: "zero_query_vector", method: "local_inference",
      submitted_inputs: 1, token_count: 4, execution_work: "unknown", external_api_attempts: 0 });
    const refusedResult = await prepare({ bind: async () => readyBind(selectionFor(profile()),
      async inputs => refused(inputs, "simulated_not_embedded", 3)) });
    expect(refusedResult.vector).toEqual({ status: "unavailable", reason: "simulated_not_embedded" });
    expectReceipt(refusedResult.receipt, { status: "failed", reason: "simulated_not_embedded", submitted_inputs: 1,
      token_count: 3, method: "local_inference" });
    const unknownTokens = await prepare({ bind: async () => readyBind(selectionFor(profile()),
      async inputs => refused(inputs, "simulated_not_embedded", null)) });
    expectReceipt(unknownTokens.receipt, { status: "failed", submitted_inputs: 1, token_count: null });
    const thrown = await prepare({ bind: async () => readyBind(selectionFor(profile()), async () => {
      throw new Error("embed failed");
    }) });
    expectReceipt(thrown.receipt, { status: "failed", reason: "query_preparation_failed", submitted_inputs: 1,
      token_count: null, execution_work: "unknown" });
  });

  it("counts a successful submission once and leaves rejected paths unsubmitted", async () => {
    const fixtureVector = new Float32Array([0.6, 0.8, 0]);
    const embed = vi.fn(async (inputs: readonly SourceEmbeddingInput[], options: { timeoutMs: number }) => {
      expect(inputs).toEqual([{ input_id: DIGEST, text: NAVIGATION }]);
      expect(options.timeoutMs).toBe(5_000);
      return embedded(inputs, fixtureVector);
    });
    const selected = selectionFor(profile());
    const ready = await prepare({ selection: selected, bind: async () => readyBind(selected, embed) });
    expect(embed).toHaveBeenCalledTimes(1);
    expect(ready.vector.status).toBe("available");
    if (ready.vector.status !== "available") throw new Error("expected available query vector");
    expect(ready.vector.profile_id).toBe(selected.profile_id);
    expect(ready.vector.input_digest).toBe(DIGEST);
    expect(ready.vector.embedding).not.toBe(fixtureVector);
    expect(Array.from(ready.vector.embedding)).toEqual(Array.from(fixtureVector));
    fixtureVector[0] = 0;
    expect(ready.vector.embedding[0]).toBeCloseTo(0.6);
    expectReceipt(ready.receipt, { status: "ready", reason: null, method: "local_inference", submitted_inputs: 1,
      token_count: 2, binding_work: "unknown", execution_work: "unknown", external_api_attempts: 0 });
    const bind = vi.fn();
    const rejected = await prepare({ selection: { ...selected, config_id: ZERO }, bind });
    expect(bind).not.toHaveBeenCalled();
    expectReceipt(rejected.receipt, { submitted_inputs: 0, method: "not_run", status: "unavailable" });
  });

  it.each([
    { label: "unsupported", bind: async () => ({ status: "unsupported" as const, reason: "binding_unsupported" }),
      reason: "binding_unsupported", status: "unavailable" as const },
    { label: "sync Error", bind: () => { throw new Error("bind failed"); },
      reason: "query_preparation_failed", status: "failed" as const },
    { label: "non-Error throw", bind: () => { throw "bind failed"; },
      reason: "query_preparation_unknown", status: "failed" as const }
  ])("accounts binding $label without submitting inputs", async expected => {
    const selected = selectionFor(profile());
    const result = await prepare({ selection: selected, bind: expected.bind });
    expect(result.vector).toEqual({ status: "unavailable", reason: expected.reason });
    expectReceipt(result.receipt, { status: expected.status, reason: expected.reason, selected: { profile_id: selected.profile_id },
      method: "not_run", submitted_inputs: 0, token_count: null, binding_work: "unknown",
      execution_work: "not_run", external_api_attempts: null });
  });

  it("orders abort ahead of remainingMs and does not submit after an expired binding", async () => {
    const selected = selectionFor(profile());
    const embed = vi.fn(async (inputs: readonly SourceEmbeddingInput[]) => embedded(inputs));
    const expired = await prepare({ selection: selected, remainingMs: () => 0,
      bind: async () => readyBind(selected, embed) });
    expect(embed).not.toHaveBeenCalled();
    expect(expired.vector).toEqual({ status: "unavailable", reason: "preparation_deadline" });
    expectReceipt(expired.receipt, { status: "unavailable", reason: "preparation_deadline", submitted_inputs: 0,
      binding_work: "unknown", execution_work: "not_run", token_count: null, external_api_attempts: null });
    const opened = deferred(), release = deferred();
    const controller = new AbortController();
    const pending = prepare({ selection: selected, signal: controller.signal, remainingMs: () => 0,
      bind: async () => { opened.resolve(); await release.promise; return readyBind(selected, embed); } });
    await opened.promise;
    controller.abort();
    release.resolve();
    const aborted = await pending;
    expect(embed).not.toHaveBeenCalled();
    expectReceipt(aborted.receipt, { status: "failed", reason: "preparation_deadline", submitted_inputs: 0,
      binding_work: "unknown", token_count: null });
    const bind = vi.fn(async () => readyBind(selected, embed));
    const preAborted = await prepare({ selection: selected, signal: AbortSignal.abort(), remainingMs: () => 5_000, bind });
    expect(bind).not.toHaveBeenCalled();
    expectReceipt(preAborted.receipt, { status: "failed", reason: "preparation_deadline", binding_work: "not_run",
      submitted_inputs: 0, external_api_attempts: 0 });
  });

  it("discards an embed that finishes after abort or deadline without recording tokens as observed", async () => {
    const selected = selectionFor(profile());
    const opened = deferred(), release = deferred();
    const controller = new AbortController();
    const embed = vi.fn(async (inputs: readonly SourceEmbeddingInput[]) => {
      opened.resolve(); await release.promise; return embedded(inputs, new Float32Array([1, 0, 0]), 7);
    });
    const pending = prepare({ selection: selected, signal: controller.signal, remainingMs: () => 5_000,
      bind: async () => readyBind(selected, embed) });
    await opened.promise;
    controller.abort();
    release.resolve();
    const aborted = await pending;
    expect(embed).toHaveBeenCalledTimes(1);
    expectReceipt(aborted.receipt, { status: "failed", reason: "preparation_deadline", submitted_inputs: 1,
      token_count: null, execution_work: "unknown" });
    let remaining = 25;
    const late = await prepare({ selection: selected, remainingMs: () => remaining,
      bind: async () => readyBind(selected, async inputs => {
        remaining = 0;
        return embedded(inputs, new Float32Array([1, 0, 0]), 7);
      }) });
    expectReceipt(late.receipt, { status: "unavailable", reason: "preparation_deadline", submitted_inputs: 1,
      token_count: null, execution_work: "unknown" });
  });

  it("keeps local inference attempts at zero and opaque API attempt counts unknown", async () => {
    const local = selectionFor(profile());
    const localReady = await prepare({ selection: local, bind: async () => readyBind(local, async inputs => embedded(inputs)) });
    expectReceipt(localReady.receipt, { status: "ready", method: "local_inference", submitted_inputs: 1,
      external_api_attempts: 0, binding_work: "unknown", execution_work: "unknown" });
    const remote = selectionFor(profile({ provider_kind: "opaque-remote-api" }));
    const apiReady = await prepare({ selection: remote, bind: async () => readyBind(remote, async inputs => embedded(inputs)) });
    expectReceipt(apiReady.receipt, { status: "ready", method: "external_api", submitted_inputs: 1,
      external_api_attempts: null, binding_work: "unknown", execution_work: "unknown" });
    expect(apiReady.receipt.external_api_attempts).not.toBe(0);
    expect(apiReady.receipt.external_api_attempts).not.toBe(1);
    const unsupported = await prepare({ selection: remote, bind: async () => ({ status: "unsupported", reason: "opaque_api_unbound" }) });
    expectReceipt(unsupported.receipt, { status: "unavailable", reason: "opaque_api_unbound", method: "not_run",
      submitted_inputs: 0, external_api_attempts: null, binding_work: "unknown", execution_work: "not_run" });
  });

  it("lexical control does not bind or embed and reports not_requested", async () => {
    const bind = vi.fn(async () => { throw new Error("bind must not run"); });
    const prepared = await SourceIndexAcquisition.prepareQuery({
      navigation: NAVIGATION, selection: selectionFor(profile()), bind,
      signal: new AbortController().signal, remainingMs: () => 5_000
    }, "lexical");
    expect(bind).not.toHaveBeenCalled();
    expect(prepared.vector).toEqual({ status: "unavailable", reason: SourceIndexAcquisition.channelNotRequested });
    expect(prepared.receipt.status).toBe("not_requested");
    expect(prepared.receipt.reason).toBe(SourceIndexAcquisition.channelNotRequested);
    expect(prepared.receipt.submitted_inputs).toBe(0);
    expect(prepared.receipt.elapsed_ms).toBe(0);
  });
});
