import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fieldContractSha256, SourceIndexAcquisition, type SourceEmbeddingInput, type SourceEmbeddingResult } from "@do-soul/alaya-core";
import { hashContentDigest, sourceIndexProfileId } from "@do-soul/alaya-protocol";
import { configuration, fixture, publishSource, WORKSPACE } from
  "../../../../../../packages/storage/src/__tests__/repos/source-index/source-index-fixture.js";
import { createSourceIndexProducer, type SourceIndexProducerBind } from "../../../runtime/source-index/source-index-producer.js";

const directories: string[] = [];
const environments: ReturnType<typeof fixture>[] = [];
const producers: ReturnType<typeof createSourceIndexProducer>[] = [];
afterEach(async () => {
  for (const producer of producers.splice(0)) await producer.stop();
  for (const environment of environments.splice(0)) environment.database.close({ optimize: false });
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function environment() {
  const directory = mkdtempSync(join(tmpdir(), "source-index-dimensions-"));
  directories.push(directory);
  const value = fixture(join(directory, "index.sqlite")); environments.push(value); return value;
}
function sourceBind(refuse = false): SourceIndexProducerBind {
  return async options => {
    const profile = configuration({ provider_kind: "local_onnx", model_id: "Xenova/bge-m3", dimensions: 1024,
      normalization: "cls.l2.q8.v1", max_input_tokens: options.max_input_tokens ?? 8192,
      windowing: options.windowing ?? "recorded-message-windows.v1", window_bytes: options.window_bytes }).profile;
    return { status: "ready", profile, profile_id: sourceIndexProfileId(profile, fieldContractSha256),
      embedInputs: async (inputs: readonly SourceEmbeddingInput[]): Promise<readonly SourceEmbeddingResult[]> => inputs.map(input => {
        const evidence = { input_id: input.input_id, input_digest: hashContentDigest(input.text, fieldContractSha256) };
        if (refuse) return { ...evidence, status: "not_embedded" as const, token_count: 8193, reason: "input_token_limit" };
        const vector = new Float32Array(1024); vector[0] = 1;
        return { ...evidence, status: "embedded" as const, vector, token_count: 2, truncated: false as const };
      }) };
  };
}
function producerFor(value: ReturnType<typeof fixture>, bind: SourceIndexProducerBind) {
  const producer = createSourceIndexProducer({ database: value.database, bindSourceEmbedding: bind, warn: vi.fn(),
    limits: { work: 1_000_000, nativeBytes: 8 * 1024 * 1024 } });
  producers.push(producer); return producer;
}

describe("Source index dimensional binding through SQLite", () => {
  it("publishes 1024-dimensional recorded-message windows and fences a retired generation", async () => {
    const value = environment(), bind = sourceBind();
    publishSource(value, "alpha ".repeat(1600));
    const receipt = await producerFor(value, bind).runPass(undefined, undefined, "recorded-message-windows.v1");
    expect(receipt).toMatchObject({ status: "settled", binding: { status: "ready", profile: { dimensions: 1024, window_bytes: 8184 } } });
    const state = value.index.state(WORKSPACE);
    if (state.status !== "ready" || state.active_generation_id === null) throw new Error("Source generation must activate");
    const rows = value.database.connection.prepare("SELECT window_id, dimensions FROM source_index_vectors WHERE workspace_id=? AND generation_id=?")
      .all(WORKSPACE, state.active_generation_id) as Array<{ window_id: string; dimensions: number }>;
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every(row => row.dimensions === 1024)).toBe(true);
    const prepared = await SourceIndexAcquisition.prepareQuery({ navigation: "alpha", selection: state.selection, bind,
      signal: new AbortController().signal, remainingMs: () => 5_000 });
    expect(prepared.vector).toMatchObject({ status: "available", profile_id: state.selection.profile_id });
    const next = value.index.select(WORKSPACE, { ...state.selection.configuration, profile: {
      ...state.selection.configuration.profile, artifact_digest: `sha256:${"b".repeat(64)}` } });
    expect(next.profile_id).not.toBe(state.selection.profile_id);
    const vector = new Float32Array(1024); vector[0] = 1;
    expect(value.index.writeVector(WORKSPACE, state.active_generation_id, { window_id: rows[0]!.window_id,
      input_digest: `sha256:${"a".repeat(64)}`, embedding: vector, token_count: 2, truncated: false })).toMatchObject({ status: "rejected" });
    expect(value.index.state(WORKSPACE)).toMatchObject({ active_generation_id: null });
  });

  it("keeps a 1024-dimensional generation incomplete when a window exceeds the token limit", async () => {
    const value = environment(); publishSource(value, "source body");
    const receipt = await producerFor(value, sourceBind(true)).runPass(undefined, undefined, "recorded-message-windows.v1");
    expect(receipt).toMatchObject({ status: "token_limit", reason: "input_token_limit" });
    expect(value.index.state(WORKSPACE)).toMatchObject({ active_generation_id: null });
  });
});
