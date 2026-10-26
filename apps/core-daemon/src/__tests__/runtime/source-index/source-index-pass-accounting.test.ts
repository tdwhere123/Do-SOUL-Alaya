import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const url = new URL("../../../../../../packages/core/src/__tests__/embedding-recall/authored-source-embedding-guard.mjs", import.meta.url);
  return (await import(/* @vite-ignore */ url.href)).isolation;
});
afterAll(() => { expect(isolation.violations).toEqual([]); isolation.restore(); });
import { hashContentDigest, sourceIndexProfileId } from "@do-soul/alaya-protocol";
import { __resetCjkSegmentationStateForTests } from "@do-soul/alaya-cjk-segmentation";
import { configuration, fieldSha256, fixture, publishSource, WORKSPACE } from
  "../../../../../../packages/storage/src/__tests__/repos/source-index/source-index-fixture.js";
import { SourceIndexProducer } from "../../../runtime/source-index/source-index-producer.js";

afterEach(() => { vi.restoreAllMocks(); __resetCjkSegmentationStateForTests(); });

it("reports no visits and effective restrictions when another pass is occupied or the producer is stopped", async () => {
  const { database } = fixture();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const producer = new SourceIndexProducer({ database, warn: vi.fn(), bindSourceEmbedding: async () => {
    await blocked;
    return { status: "unsupported", reason: "runtime_missing" };
  } });
  const limits = { maxRootsPerPass: 0, maxCapturePages: 0, work: 0 };
  try {
    const running = producer.runPass(limits);
    expect(await producer.runPass(limits)).toMatchObject({ status: "busy", visited_roots: 0, capture_pages: 0, limits });
    release();
    expect(await running).toMatchObject({ visited_roots: 0, capture_pages: 0, limits });
    await producer.stop();
    expect(await producer.runPass(limits)).toMatchObject({ status: "stopped", visited_roots: 0, capture_pages: 0, limits });
  } finally { release(); await producer.stop(); database.close({ optimize: false }); }
});

it("shares root and census caps across lexical and vector work and reports effective pass restrictions", async () => {
  const environment = fixture(), { database, index } = environment;
  for (let root = 0; root < 3; root++) publishSource(environment, "needle", `source-${root}`);
  index.lexical.selectLexical(WORKSPACE, "raw-unicode61.v1");
  const producer = new SourceIndexProducer({ database, warn: vi.fn(), limits: { maxRootsPerPass: 16 },
    bindSourceEmbedding: async options => {
      const profile = configuration({ window_bytes: options.window_bytes, max_input_tokens: 32 }).profile;
      return { status: "ready", profile, profile_id: sourceIndexProfileId(profile, fieldSha256),
        embedInputs: async inputs => inputs.map(input => ({ status: "embedded", input_id: input.input_id,
          input_digest: hashContentDigest(input.text, fieldSha256), vector: new Float32Array([0.6, 0.8, 0]),
          token_count: 2, truncated: false })) };
    } });
  try {
    const first = await producer.runPass({ maxRootsPerPass: 3, maxCapturePages: 2 });
    expect(first).toMatchObject({ visited_roots: 3, capture_pages: 2,
      limits: { maxRootsPerPass: 3, maxCapturePages: 2 } });
    const lexical = index.lexical.lexicalState(WORKSPACE)!;
    const generations = database.connection.prepare("SELECT completed_count FROM source_index_lexical_generations WHERE workspace_id=?").all(WORKSPACE);
    expect(generations).toEqual([{ completed_count: 2 }]);
    expect(lexical.active_generation_id).toBeNull();
    expect(database.connection.prepare("SELECT count(DISTINCT root_key) AS n FROM source_index_vectors WHERE workspace_id=?").get(WORKSPACE))
      .toEqual({ n: 1 });
    expect(first.resources.work).toBeGreaterThan(0);
    expect(first.resources.native_bytes).toBeGreaterThan(0);
    const second = await producer.runPass({ maxRootsPerPass: 3, maxCapturePages: 0 });
    expect(second).toMatchObject({ visited_roots: 3, capture_pages: 0, limits: { maxCapturePages: 0 } });
    expect(index.lexical.lexicalState(WORKSPACE)?.active_generation_id).not.toBeNull();
    expect(index.state(WORKSPACE)).toMatchObject({ status: "ready" });
  } finally { await producer.stop(); database.close({ optimize: false }); }
});

it("debits rolled-back lexical copies before returning a producer receipt", async () => {
  const environment = fixture(), { database } = environment;
  publishSource(environment, "first", "one"); publishSource(environment, "second", "two");
  const producer = new SourceIndexProducer({ database, warn: vi.fn(),
    bindSourceEmbedding: async () => ({ status: "unsupported", reason: "runtime_missing" }) });
  try {
    expect(await producer.runLexicalPass(WORKSPACE, "raw-unicode61.v1")).toMatchObject({ status: "ready" });
    publishSource(environment, "third", "three");
    database.connection.exec(`CREATE TEMP TRIGGER refuse_second_lexical_copy BEFORE INSERT ON source_index_lexical_projections
      WHEN (SELECT count(*) FROM source_index_lexical_projections WHERE generation_id=NEW.generation_id)=1
      BEGIN SELECT RAISE(ABORT, 'authored copy failure'); END`);
    const failed = await producer.runPass({ maxRootsPerPass: 4, maxCapturePages: 1 });
    expect(failed).toMatchObject({ visited_roots: 2, capture_pages: 1, accounting: "lower_bound" });
    expect(failed.resources.work).toBeGreaterThan(0);
    expect(database.connection.prepare("SELECT completed_count FROM source_index_lexical_generations WHERE status='building' AND workspace_id=?")
      .all(WORKSPACE)).toEqual([{ completed_count: 0 }]);
  } finally { await producer.stop(); database.close({ optimize: false }); }
});

it("counts lexical-only visits and respects a zero census allowance rather than silently increasing it", async () => {
  const environment = fixture(), { database, index } = environment;
  publishSource(environment, "needle", "one"); publishSource(environment, "needle", "two");
  publishSource(environment, "another workspace root", "three", { workspace_id: "workspace-2" });
  for (const workspace of [WORKSPACE, "workspace-2"]) index.lexical.selectLexical(workspace, "raw-unicode61.v1");
  const producer = new SourceIndexProducer({ database, warn: vi.fn(),
    bindSourceEmbedding: async () => ({ status: "unsupported", reason: "runtime_missing" }) });
  try {
    const blocked = await producer.runPass({ maxCapturePages: 0 });
    expect(blocked).toMatchObject({ visited_roots: 0, capture_pages: 0, limits: { maxCapturePages: 0 } });
    expect(database.connection.prepare("SELECT count(*) AS n FROM source_index_lexical_targets").get()).toEqual({ n: 0 });
    const next = await producer.runPass({ maxRootsPerPass: 2, maxCapturePages: 1 });
    expect(next).toMatchObject({ visited_roots: 1, capture_pages: 1, limits: { maxRootsPerPass: 2 } });
    expect(database.connection.prepare("SELECT count(*) AS n FROM source_index_lexical_targets WHERE workspace_id=?")
      .get("workspace-2")).toEqual({ n: 0 });
    expect(database.connection.prepare("SELECT completed_count FROM source_index_lexical_generations WHERE workspace_id=?").get(WORKSPACE))
      .toEqual({ completed_count: 1 });
  } finally { await producer.stop(); database.close({ optimize: false }); }
});
