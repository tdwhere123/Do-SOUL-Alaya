import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceIndexSelection } from "@do-soul/alaya-protocol";
import { SourceIndexBackfill } from "../../source-index/source-index-backfill.js";
import { SourceIndexLifecycle } from "../../source-index/source-index-lifecycle.js";
import type {
  SourceEmbeddingBinding, SourceEmbeddingInput, SourceEmbeddingResult
} from "../../embedding-recall/source-embedding-runtime.js";
import {
  BUDGET, WORKSPACE, configuration, fieldPointer, fieldSha256, fixture, lexicalRows, publishSource, type Fixture
} from "../../../../storage/src/__tests__/repos/source-index/source-index-fixture.js";

const environments: Fixture[] = [];
const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const environment of environments.splice(0)) environment.database.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const digest = (text: string) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(fulfill => { resolve = fulfill; });
  return { promise, resolve };
}
function embedded(inputs: readonly SourceEmbeddingInput[]): readonly SourceEmbeddingResult[] {
  return inputs.map(input => ({ status: "embedded", input_id: input.input_id, input_digest: digest(input.text),
    vector: new Float32Array([0.6, 0.8, 0]), token_count: 2, truncated: false }));
}
// Controlled, explicitly fixture-only runtime evidence. No provider, model loading or inference occurs.
function controlledBinding(selection: SourceIndexSelection,
  implementation: SourceEmbeddingBinding["embedInputs"] = async inputs => embedded(inputs)) {
  return { status: "ready" as const, profile: { ...selection.configuration.profile }, profile_id: selection.profile_id,
    embedInputs: vi.fn(implementation) };
}
function setup(body = "Alpha猫\nβeta!", fileBacked = false) {
  const directory = fileBacked ? mkdtempSync(join(tmpdir(), "source-backfill-")) : undefined;
  if (directory !== undefined) directories.push(directory);
  const environment = fixture(directory === undefined ? undefined : join(directory, "index.sqlite"));
  environments.push(environment);
  const source = publishSource(environment, body);
  const lifecycle = new SourceIndexLifecycle(environment.index, fieldSha256);
  const selection = lifecycle.select(WORKSPACE, configuration());
  const generation = lifecycle.begin(selection);
  lifecycle.capture(WORKSPACE, generation.generation_id, 8, BUDGET);
  const [target] = environment.index.listTargets(WORKSPACE, generation.generation_id, null, 8);
  if (target === undefined) throw new Error("expected captured SQLite root");
  const backfill = new SourceIndexBackfill(lifecycle);
  const input = { selection, generation_id: generation.generation_id, root_key: target.root_key,
    binding: controlledBinding(selection), budget: { ...BUDGET, model_inputs: 10, input_bytes: 1024, max_body_bytes: 1024 },
    deadline_ms: Date.now() + 60_000, signal: new AbortController().signal };
  const vectors = () => environment.database.connection.prepare(`SELECT w.ordinal,v.window_id,v.token_count,v.embedding_blob
    FROM source_index_vectors v JOIN source_index_windows w USING(workspace_id,generation_id,window_id)
    WHERE v.workspace_id=? AND v.generation_id=? ORDER BY w.ordinal`).all(WORKSPACE, generation.generation_id);
  return { ...environment, source, lifecycle, selection, generation, target, backfill, input, vectors };
}

describe("Source captured-root backfill through SQLite with a controlled runtime", () => {
  it("submits independently identified exact Unicode windows with the verified profile outside a SQLite transaction", async () => {
    const environment = setup();
    const field = fieldPointer(environment.database);
    const binding = controlledBinding(environment.selection, async (inputs, options) => {
      expect(environment.database.connection.inTransaction).toBe(false);
      expect(Object.isFrozen(inputs)).toBe(true);
      expect(Object.isFrozen(inputs[0])).toBe(true);
      expect(options.profile_id).toBe(environment.selection.profile_id);
      expect(options.signal?.aborted).toBe(false);
      expect(options.timeoutMs).toBeGreaterThan(0);
      expect(options.timeoutMs).toBeLessThanOrEqual(60_000);
      await Promise.resolve();
      expect(environment.database.connection.inTransaction).toBe(false);
      return embedded(inputs);
    });
    const expected = [
      { ordinal: 0, start_byte: 0, end_byte: 8, text: "Alpha猫" },
      { ordinal: 1, start_byte: 8, end_byte: 15, text: "\nβeta!" }
    ].map(window => ({ ...window, input_id: digest(JSON.stringify(["source-index-window.v1", environment.target.root_key,
      environment.selection.profile_id, window.start_byte, window.end_byte, digest(window.text)])) }));
    const result = await environment.backfill.step({ ...environment.input, binding });
    expect(result).toMatchObject({ status: "root_complete", reason: "no_pending_windows", accepted_vectors: 2,
      resources: { work: 32, native_accounting: "complete", sql_internal_work: "unknown", model_inputs_submitted: 2,
        model_input_bytes_submitted: 15, token_count_observed: 4, inputs_without_token_count: 0, model_execution_work: "unknown" } });
    expect(binding.embedInputs.mock.calls.map(([inputs]) => inputs)).toEqual(
      expected.map(({ input_id, text }) => [{ input_id, text, role: "passage" }]));
    expect(environment.database.connection.prepare(`SELECT ordinal,start_byte,end_byte,body,window_id
      FROM source_index_windows ORDER BY ordinal`).all()).toEqual(expected.map(({ text, input_id, ...window }) =>
      ({ ...window, body: text, window_id: input_id })));
    expect(environment.vectors()).toEqual(expected.map(({ ordinal, input_id }) => ({ ordinal, window_id: input_id,
      token_count: 2, embedding_blob: Buffer.from([154, 153, 25, 63, 205, 204, 76, 63, 0, 0, 0, 0]) })));
    expect(lexicalRows(environment.database)).toEqual([{ root_key: environment.target.root_key, body: "Alpha猫\nβeta!", body_bytes: 15 }]);
    expect(environment.index.generation(WORKSPACE, environment.generation.generation_id)).toMatchObject({
      status: "building", completed_count: 1, target_count: 1, enumeration_complete: true
    });
    expect(environment.index.state(WORKSPACE)).toMatchObject({ status: "building", active_generation_id: null });
    expect(environment.database.connection.prepare(`SELECT workspace_id,active_generation_id,activated_at
      FROM projection_generation_pointer WHERE workspace_id=?`).get(WORKSPACE)).toEqual(field.pointer);
  });

  it("captures selection, budget, root, runtime method and profile before awaiting the first result", async () => {
    const environment = setup();
    const gate = deferred<readonly SourceEmbeddingResult[]>();
    let firstInputs: readonly SourceEmbeddingInput[] = [];
    const binding = controlledBinding(environment.selection, async inputs => {
      if (firstInputs.length === 0) { firstInputs = inputs; return gate.promise; }
      return embedded(inputs);
    });
    const originalEmbed = binding.embedInputs;
    const selection = { ...environment.selection, configuration: { ...environment.selection.configuration,
      profile: { ...environment.selection.configuration.profile } } };
    const input = { ...environment.input, selection, binding, budget: { ...environment.input.budget } };
    const pending = environment.backfill.step(input);
    expect(originalEmbed).toHaveBeenCalledTimes(1);
    expect(environment.vectors()).toEqual([]);
    expect(environment.database.connection.inTransaction).toBe(false);
    input.root_key = "mutated-root";
    input.generation_id = "mutated-generation";
    input.budget.model_inputs = 0;
    input.budget.input_bytes = 0;
    input.deadline_ms = 0;
    selection.workspace_id = "mutated-workspace";
    selection.config_id = `sha256:${"f".repeat(64)}`;
    selection.configuration.profile.dimensions = 1;
    binding.profile.dimensions = 1;
    binding.profile.max_input_tokens = 1;
    binding.profile_id = `sha256:${"f".repeat(64)}`;
    binding.embedInputs = vi.fn(async () => { throw new Error("mutated runtime method must not execute"); });
    gate.resolve(embedded(firstInputs));
    expect(await pending).toMatchObject({ status: "root_complete", accepted_vectors: 2,
      resources: { model_inputs_submitted: 2, model_input_bytes_submitted: 15 } });
    expect(originalEmbed).toHaveBeenCalledTimes(2);
    expect(binding.embedInputs).not.toHaveBeenCalled();
    expect(originalEmbed.mock.calls.map(([, options]) => options.profile_id)).toEqual([
      environment.selection.profile_id, environment.selection.profile_id
    ]);
    expect(environment.vectors()).toHaveLength(2);
  });

  it.each(["runtime profile", "runtime profile id", "selection profile id", "selection configuration id"] as const)(
    "rejects an unverified %s before any preparation or model submission", async mismatch => {
      const environment = setup();
      const binding = controlledBinding(environment.selection);
      const selection = { ...environment.selection };
      if (mismatch === "runtime profile") binding.profile.model_revision = "not-selected";
      else if (mismatch === "runtime profile id") binding.profile_id = `sha256:${"f".repeat(64)}`;
      else if (mismatch === "selection profile id") selection.profile_id = `sha256:${"f".repeat(64)}`;
      else selection.config_id = `sha256:${"f".repeat(64)}`;
      await expect(environment.backfill.step({ ...environment.input, selection, binding })).rejects.toMatchObject({ code: "VALIDATION" });
      expect(binding.embedInputs).not.toHaveBeenCalled();
      expect(environment.database.connection.prepare("SELECT window_id FROM source_index_windows").all()).toEqual([]);
      expect(environment.vectors()).toEqual([]);
    });

  it("retains partial accepts through re-preparation, a subsequent step and a file-backed database reopen", async () => {
    const environment = setup("Alpha猫\nβeta!終", true);
    const budget = { ...environment.input.budget, model_inputs: 1 };
    expect(await environment.backfill.step({ ...environment.input, budget })).toMatchObject({
      status: "resource_exhausted", reason: "model_input_budget", accepted_vectors: 1
    });
    const accepted = environment.vectors();
    expect(accepted).toMatchObject([{ ordinal: 0, token_count: 2 }]);
    expect(environment.lifecycle.prepare(WORKSPACE, environment.generation.generation_id, environment.target.root_key, BUDGET).status).toBe("ready");
    expect(environment.vectors()).toEqual(accepted);
    const secondBinding = controlledBinding(environment.selection);
    expect(await environment.backfill.step({ ...environment.input, binding: secondBinding, budget })).toMatchObject({
      status: "resource_exhausted", reason: "model_input_budget", accepted_vectors: 1
    });
    expect(secondBinding.embedInputs.mock.calls.map(([inputs]) => inputs.map(input => input.text))).toEqual([["\nβeta!"]]);
    expect(environment.vectors()).toHaveLength(2);
    const connectionVersion = environment.database.getConnectionVersion();
    environment.database.close();
    const lifecycle = new SourceIndexLifecycle(environment.index, fieldSha256);
    const finalBinding = controlledBinding(environment.selection);
    expect(await new SourceIndexBackfill(lifecycle).step({ ...environment.input, binding: finalBinding, budget })).toMatchObject({
      status: "root_complete", accepted_vectors: 1
    });
    expect(environment.database.getConnectionVersion()).toBeGreaterThan(connectionVersion);
    expect(finalBinding.embedInputs.mock.calls.map(([inputs]) => inputs.map(input => input.text))).toEqual([["終"]]);
    expect(environment.vectors()).toMatchObject([{ ordinal: 0 }, { ordinal: 1 }, { ordinal: 2 }]);
    expect(environment.vectors()[0]).toEqual(accepted[0]);
    const completeBinding = controlledBinding(environment.selection);
    expect(await new SourceIndexBackfill(lifecycle).step({ ...environment.input, binding: completeBinding })).toMatchObject({
      status: "root_complete", accepted_vectors: 0, resources: { model_inputs_submitted: 0, model_execution_work: "not_run" }
    });
    expect(completeBinding.embedInputs).not.toHaveBeenCalled();
    expect(environment.index.state(WORKSPACE)).toMatchObject({ active_generation_id: null });
  });

  it.each([
    ["input_token_limit", 9, "token_limit"], ["runtime_closed", null, "unsupported"],
    ["cancelled", null, "cancelled"], ["fixture_runtime_failed", 3, "failed"]
  ] as const)("keeps runtime %s distinct as %s with submitted costs", async (reason, tokenCount, status) => {
    const environment = setup("one");
    const binding = controlledBinding(environment.selection, async inputs => inputs.map(input => ({ status: "not_embedded",
      input_id: input.input_id, input_digest: digest(input.text), reason, token_count: tokenCount })));
    expect(await environment.backfill.step({ ...environment.input, binding })).toMatchObject({ status, reason, accepted_vectors: 0,
      resources: { work: 18, native_accounting: "complete", model_inputs_submitted: 1, model_input_bytes_submitted: 3,
        token_count_observed: tokenCount ?? 0, inputs_without_token_count: tokenCount === null ? 1 : 0, model_execution_work: "unknown" } });
    expect(environment.vectors()).toEqual([]);
    expect(environment.index.state(WORKSPACE)).toMatchObject({ active_generation_id: null });
  });

  it("returns unsupported capability without conflating it with successful empty or zero-cost failed inference", async () => {
    const environment = setup();
    expect(await environment.backfill.step({ ...environment.input,
      binding: { status: "unsupported", reason: "fixture_capability_unavailable" } })).toMatchObject({
      status: "unsupported", reason: "fixture_capability_unavailable", accepted_vectors: 0,
      resources: { work: 0, native_bytes: 0, model_inputs_submitted: 0, model_execution_work: "not_run" }
    });
    expect(environment.vectors()).toEqual([]);
    expect(lexicalRows(environment.database)).toEqual([]);
  });

  it.each(["missing generation", "missing root", "failed generation", "stale source", "superseded selection"] as const)(
    "distinguishes %s without submitting inference", async state => {
      const environment = setup("one");
      const input = { ...environment.input };
      let status = "unbound", reason = "missing_generation";
      if (state === "missing generation") input.generation_id = "missing-generation";
      else if (state === "missing root") { input.root_key = "missing-root"; reason = "missing_target"; }
      else if (state === "failed generation") {
        environment.lifecycle.fail(WORKSPACE, environment.generation.generation_id, "interrupted");
        status = "failed"; reason = "incomplete";
      } else if (state === "stale source") {
        publishSource(environment, "replacement", "source-a", { source_version: "v2", recorded_at: "2026-09-22T00:00:00Z" });
        status = reason = "stale";
      } else {
        environment.lifecycle.select(WORKSPACE, configuration({ model_revision: "v2" }));
        status = reason = "superseded";
      }
      expect(await environment.backfill.step(input)).toMatchObject({ status, reason, accepted_vectors: 0,
        resources: { work: 0, native_bytes: 0, model_inputs_submitted: 0, model_execution_work: "not_run" } });
      expect(input.binding.embedInputs).not.toHaveBeenCalled();
      expect(environment.vectors()).toEqual([]);
    });

  it.each(["update", "delete", "model selection switch"] as const)(
    "rejects delayed vectors after native %s while inference is awaiting", async mutation => {
      const environment = setup("one");
      const gate = deferred<readonly SourceEmbeddingResult[]>();
      let captured: readonly SourceEmbeddingInput[] = [];
      const binding = controlledBinding(environment.selection, async inputs => { captured = inputs; return gate.promise; });
      const pending = environment.backfill.step({ ...environment.input, binding });
      expect(binding.embedInputs).toHaveBeenCalledTimes(1);
      expect(environment.database.connection.inTransaction).toBe(false);
      if (mutation === "update") {
        const replacement = publishSource(environment, "replacement", "source-a", {
          source_version: "v2", recorded_at: "2026-09-22T00:00:00Z"
        });
        expect(environment.records.findCurrent(WORKSPACE, "source-a")?.record_id).toBe(replacement.record_id);
      } else if (mutation === "delete") {
        expect(environment.database.connection.prepare("DELETE FROM source_records WHERE workspace_id=? AND record_id=?")
          .run(WORKSPACE, environment.source.record_id).changes).toBe(1);
      } else environment.lifecycle.select(WORKSPACE, configuration({ model_revision: "v2" }));
      gate.resolve(embedded(captured));
      const status = mutation === "model selection switch" ? "superseded" : "stale";
      expect(await pending).toMatchObject({ status, reason: status, accepted_vectors: 0,
        resources: { work: 18, model_inputs_submitted: 1, model_input_bytes_submitted: 3, token_count_observed: 2 } });
      expect(environment.vectors()).toEqual([]);
      expect(environment.index.state(WORKSPACE)).toMatchObject({ active_generation_id: null });
    });

  it("does not publish even an empty captured root when there are no model inputs to submit", async () => {
    const environment = setup("");
    expect(await environment.backfill.step(environment.input)).toMatchObject({ status: "root_complete", accepted_vectors: 0,
      resources: { model_inputs_submitted: 0, model_execution_work: "not_run" } });
    expect(environment.input.binding.embedInputs).not.toHaveBeenCalled();
    expect(environment.index.generation(WORKSPACE, environment.generation.generation_id)).toMatchObject({
      status: "building", completed_count: 1, target_count: 1
    });
    expect(environment.index.state(WORKSPACE)).toMatchObject({ active_generation_id: null });
  });
});
