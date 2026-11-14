import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const url = new URL("../../../../../../packages/core/src/__tests__/embedding-recall/authored-source-embedding-guard.mjs", import.meta.url);
  return (await import(/* @vite-ignore */ url.href)).isolation;
});
afterAll(() => { expect(isolation.violations).toEqual([]); isolation.restore(); });
import { SourceIndexLifecycle } from "@do-soul/alaya-core";
import { hashContentDigest, sourceIndexProfileId } from "@do-soul/alaya-protocol";
import { BUDGET, WORKSPACE, buildReady, configuration, fieldSha256, fixture, publishSource, type Fixture } from
  "../../../../../../packages/storage/src/__tests__/repos/source-index/source-index-fixture.js";
import { publishFullContextStatement } from
  "../../../../../../packages/storage/src/__tests__/repos/source-index/source-template-fixture.js";
import { SourceIndexProducer, type SourceIndexProducerBind } from "../../../runtime/source-index/source-index-producer.js";

const environments: Fixture[] = [], producers: SourceIndexProducer[] = [];
afterEach(async () => {
  for (const producer of producers.splice(0)) await producer.stop();
  vi.restoreAllMocks();
  for (const environment of environments.splice(0)) environment.database.close({ optimize: false });
  expect(isolation.violations).toEqual([]);
});
const config = { ...configuration({ max_input_tokens: 32, window_bytes: 24 }), revision: "source-index-local.v1" };
function binding(failure = false) {
  const embed = vi.fn(async (inputs: readonly { input_id: string; text: string }[]) => {
    if (failure) throw new Error("fixture_inference_failed");
    return inputs.map(input => ({ status: "embedded" as const, input_id: input.input_id,
      input_digest: hashContentDigest(input.text, fieldSha256), vector: new Float32Array([0.6, 0.8, 0]),
      token_count: 2, truncated: false as const }));
  });
  const bind: SourceIndexProducerBind = async options => {
    const profile = { ...config.profile, window_bytes: options.window_bytes };
    return { status: "ready", profile, profile_id: sourceIndexProfileId(profile, fieldSha256), embedInputs: embed };
  };
  return { bind, embed };
}

it.each(["partial", "failed"] as const)("retains an earlier %s truthfully when a later workspace refuses its vector census allocation", async earlier => {
  const h = fixture(); environments.push(h);
  publishSource(h, "first", "first"); publishSource(h, "second", "second");
  await publishFullContextStatement(h, "workspace-2");
  const later = h.index.begin(h.index.select("workspace-2", config));
  h.index.capturePage("workspace-2", later.generation_id, 128, BUDGET);
  expect(h.index.capturePage("workspace-2", later.generation_id, 2, BUDGET).generation)
    .toMatchObject({ records_complete: true, enumeration_complete: false, after_capsule_cursor: null });
  const lifecycle = new SourceIndexLifecycle(h.index, fieldSha256);
  // Make the second workspace's lexical lane genuinely ready, so only vector capture can refuse.
  expect(await lifecycle.prepareLexical("workspace-2", "raw-unicode61.v1", { ...BUDGET, capture_page: 128,
    max_capture_pages: 8, max_roots: 200, max_body_bytes: 65536 })).toMatchObject({ status: "ready" });
  expect(await lifecycle.prepareLexical(WORKSPACE, "raw-unicode61.v1", { ...BUDGET, capture_page: 32,
    max_capture_pages: 8, max_roots: 16, max_body_bytes: 65536 })).toMatchObject({ status: "ready" });
  const { bind, embed } = binding(earlier === "failed"), warn = vi.fn();
  const producer = new SourceIndexProducer({ database: h.database, bindSourceEmbedding: bind, warn }); producers.push(producer);
  const prepare = vi.spyOn(SourceIndexLifecycle.prototype, "prepareLexical"), capture = vi.spyOn(SourceIndexLifecycle.prototype, "capture");
  const receipt = await producer.runPass({ work: 650, maxRootsPerPass: 1 });
  expect(await prepare.mock.results[0]!.value).toMatchObject({ status: "ready" });
  expect(h.database.connection.prepare(`SELECT completed_count,target_count,enumeration_complete,status
    FROM source_index_generations WHERE workspace_id=?`).get(WORKSPACE)).toMatchObject({ target_count: 2,
    completed_count: earlier === "partial" ? 1 : 0, enumeration_complete: 1, status: earlier === "partial" ? "building" : "failed" });
  const capturedLater = capture.mock.results.at(-1)!.value;
  expect(capture.mock.calls.at(-1)![0]).toBe("workspace-2");
  expect(capturedLater.generation).toMatchObject({ generation_id: later.generation_id, status: "partial",
    reason: "enumeration_allocation_exhausted", enumeration_complete: false, after_capsule_cursor: null });
  expect(receipt).toMatchObject(earlier === "partial"
    ? { status: "resource_exhausted", reason: "enumeration_allocation_exhausted" }
    : { status: "failed", reason: "fixture_inference_failed" });
  expect(warn).toHaveBeenCalledWith("source index capture allocation exhausted", expect.objectContaining({ workspace_id: "workspace-2" }));
  expect(receipt.resources.work).toBeLessThanOrEqual(650);
  expect(receipt.resources.native_bytes).toBeLessThanOrEqual(receipt.limits.nativeBytes);
  expect(h.index.state("workspace-2")).toMatchObject({ active_generation_id: null });
  expect(embed).toHaveBeenCalledTimes(1);
});

it("reports advancing lexical census as partial while the actual vector generation is already ready", async () => {
  const h = fixture(); environments.push(h); publishSource(h, "first", "first");
  const ready = buildReady(h, config);
  h.index.lexical.selectLexical(WORKSPACE, "raw-unicode61.v1");
  const { bind, embed } = binding();
  const producer = new SourceIndexProducer({ database: h.database, bindSourceEmbedding: bind, warn: vi.fn(),
    limits: { capturePage: 1, maxCapturePages: 1, maxWorkspacesPerPass: 1 } }); producers.push(producer);
  const receipt = await producer.runPass();
  expect(receipt).toMatchObject({ status: "partial", reason: "enumeration_page", capture_pages: 1, resources: { model_inputs: 0 } });
  expect(h.index.state(WORKSPACE)).toMatchObject({ status: "ready", active_generation_id: ready.generation.generation_id });
  const lexical = h.index.lexical.lexicalState(WORKSPACE)!;
  expect(lexical.active_generation_id).toBeNull();
  expect(h.database.connection.prepare(`SELECT completed_count,target_count,enumeration_complete,after_source_id
    FROM source_index_lexical_generations WHERE workspace_id=?`).get(WORKSPACE)).toEqual({
    completed_count: 1, target_count: 1, enumeration_complete: 0, after_source_id: "first"
  });
  expect(embed).not.toHaveBeenCalled();
});

it("does not replace an unsupported binding with an ordinary lexical partial", async () => {
  const h = fixture(); environments.push(h); publishSource(h, "first", "first");
  h.index.lexical.selectLexical(WORKSPACE, "raw-unicode61.v1");
  const producer = new SourceIndexProducer({ database: h.database, warn: vi.fn(),
    bindSourceEmbedding: async () => ({ status: "unsupported", reason: "fixture_unbound" }),
    limits: { capturePage: 1, maxCapturePages: 1, maxWorkspacesPerPass: 1 } }); producers.push(producer);
  expect(await producer.runPass()).toMatchObject({ status: "unsupported", reason: "fixture_unbound",
    binding: { status: "unsupported", reason: "fixture_unbound" } });
});
