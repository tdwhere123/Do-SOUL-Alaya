import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const url = new URL("../../../../../../packages/core/src/__tests__/embedding-recall/authored-source-embedding-guard.mjs", import.meta.url);
  return (await import(/* @vite-ignore */ url.href)).isolation;
});
afterAll(() => { expect(isolation.violations).toEqual([]); isolation.restore(); });
import { SourceIndexLifecycle } from "@do-soul/alaya-core";
import { hashContentDigest, sourceIndexProfileId } from "@do-soul/alaya-protocol";
import { initDatabase, SqliteSourceIndexRepository, type StorageDatabase } from "@do-soul/alaya-storage";
import { BUDGET, WORKSPACE, configuration, fieldSha256, fixture, publishSource } from
  "../../../../../../packages/storage/src/__tests__/repos/source-index/source-index-fixture.js";
import { publishFullContextStatement } from
  "../../../../../../packages/storage/src/__tests__/repos/source-index/source-template-fixture.js";
import { SourceIndexProducer, type SourceIndexProducerBind } from "../../../runtime/source-index/source-index-producer.js";

const databases: StorageDatabase[] = [], directories: string[] = [], producers: SourceIndexProducer[] = [];
afterEach(async () => {
  for (const producer of producers.splice(0)) await producer.stop();
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) if (!database.isClosed()) database.close({ optimize: false });
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  expect(isolation.violations).toEqual([]);
});

it("reports bounded lexical and vector capture refusal through the real producer and recovers both generations after reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "producer-capture-allocation-")); directories.push(directory);
  const filename = join(directory, "index.sqlite"), h = fixture(filename); databases.push(h.database);
  h.database.connection.prepare("DELETE FROM workspaces WHERE workspace_id=?").run("workspace-2");
  const { first, later } = await publishFullContextStatement(h);
  const config = { ...configuration({ max_input_tokens: 32, window_bytes: 24 }), revision: "source-index-local.v1" };
  const vector = h.index.begin(h.index.select(WORKSPACE, config));
  const lexical = h.index.lexical.beginLexical(h.index.lexical.selectLexical(WORKSPACE, "raw-unicode61.v1"));
  for (const limit of [128, 2]) {
    h.index.capturePage(WORKSPACE, vector.generation_id, limit, BUDGET);
    h.index.lexical.captureLexicalPage(WORKSPACE, lexical.generation_id, limit, BUDGET);
  }
  const embed = vi.fn(async (inputs: readonly { input_id: string; text: string }[]) => inputs.map(input => ({
    status: "embedded" as const, input_id: input.input_id, input_digest: hashContentDigest(input.text, fieldSha256),
    vector: new Float32Array([0.6, 0.8, 0]), token_count: 2, truncated: false as const
  })));
  const bind: SourceIndexProducerBind = async options => {
    const profile = { ...config.profile, window_bytes: options.window_bytes };
    return { status: "ready", profile, profile_id: sourceIndexProfileId(profile, fieldSha256), embedInputs: embed };
  };
  const warn = vi.fn();
  const producer = new SourceIndexProducer({ database: h.database, bindSourceEmbedding: bind, warn,
    limits: { maxWorkspacesPerPass: 1 } });
  producers.push(producer);
  const capture = vi.spyOn(SourceIndexLifecycle.prototype, "capture"), reclaim = vi.spyOn(SourceIndexLifecycle.prototype, "reclaimVectorPage");
  const prepare = vi.spyOn(SourceIndexLifecycle.prototype, "prepareLexical");
  for (let round = 0; round < 3; round++) {
    capture.mockClear(); reclaim.mockClear(); prepare.mockClear(); warn.mockClear();
    const receipt = await producer.runPass({ work: 650 });
    expect(receipt).toMatchObject({ status: "resource_exhausted", reason: "enumeration_allocation_exhausted",
      capture_pages: 2, visited_roots: 0, resources: { model_inputs: 0, input_bytes: 0 }, limits: { work: 650 } });
    expect(capture).toHaveBeenCalledTimes(1); expect(prepare).toHaveBeenCalledTimes(1);
    const lexicalReceipt = await prepare.mock.results[0]!.value;
    expect(lexicalReceipt).toMatchObject({ status: "unavailable", reason: "enumeration_allocation_exhausted", capture_pages: 1 });
    const costs = [...capture.mock.results, ...reclaim.mock.results].map(result => result.value.resources);
    costs.push(lexicalReceipt.resources);
    expect(receipt.resources.work).toBe(costs.reduce((n, cost) => n + cost.work, 0));
    expect(receipt.resources.native_bytes).toBe(costs.reduce((n, cost) => n + cost.native_bytes, 0));
    expect(receipt.resources.work).toBeGreaterThan(0); expect(receipt.resources.work).toBeLessThanOrEqual(650);
    expect(receipt.resources.native_bytes).toBeLessThanOrEqual(receipt.limits.nativeBytes);
    expect(embed).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("source index lexical preparation unavailable", expect.objectContaining({ reason: receipt.reason }));
    expect(warn).toHaveBeenCalledWith("source index capture allocation exhausted", expect.objectContaining({ reason: receipt.reason }));
    expect(h.index.generation(WORKSPACE, vector.generation_id)).toMatchObject({ status: "partial", records_complete: true,
      after_capsule_cursor: null, enumeration_complete: false, target_count: 129 });
    expect(h.index.lexical.lexicalGeneration(WORKSPACE, lexical.generation_id)).toMatchObject({ status: "partial",
      after_capsule_cursor: null, enumeration_complete: false, target_count: 129 });
    expect(h.index.state(WORKSPACE)).toMatchObject({ active_generation_id: null });
    expect(h.index.lexical.lexicalState(WORKSPACE)?.active_generation_id).toBeNull();
  }
  await producer.stop(); h.database.close({ optimize: false });
  const database = initDatabase({ filename }); databases.push(database);
  const index = new SqliteSourceIndexRepository(database, fieldSha256);
  const resumed = new SourceIndexProducer({ database, bindSourceEmbedding: bind, warn,
    limits: { maxWorkspacesPerPass: 1 } });
  producers.push(resumed);
  // Recover under unchanged production work/root/model caps, across bounded passes.
  for (let round = 0; round < 40; round++) {
    const receipt = await resumed.runPass();
    expect(receipt.status).not.toBe("failed");
    expect(receipt.resources.work).toBeLessThanOrEqual(receipt.limits.work);
    expect(receipt.resources.native_bytes).toBeLessThanOrEqual(receipt.limits.nativeBytes);
    expect(receipt.resources.model_inputs).toBeLessThanOrEqual(receipt.limits.modelInputs);
    if (index.lexical.lexicalState(WORKSPACE)?.active_generation_id === lexical.generation_id &&
        index.state(WORKSPACE).status === "ready") break;
  }
  expect(index.generation(WORKSPACE, vector.generation_id)).toMatchObject({ status: "ready", enumeration_complete: true,
    target_count: 131, completed_count: 131 });
  expect(index.lexical.lexicalGeneration(WORKSPACE, lexical.generation_id)).toMatchObject({ status: "ready",
    enumeration_complete: true, target_count: 131, completed_count: 131 });
  const page = index.listTargets(WORKSPACE, vector.generation_id, null, 128);
  const targets = [...page, ...index.listTargets(WORKSPACE, vector.generation_id, page.at(-1)!.root_key, 128)];
  expect(targets).toContainEqual(expect.objectContaining({ root_key: first.source.root_key }));
  expect(targets.some(target => target.target.root_id === later.object_id)).toBe(true);
  expect(index.state(WORKSPACE)).toMatchObject({ active_generation_id: vector.generation_id });
  expect(index.lexical.lexicalState(WORKSPACE)?.active_generation_id).toBe(lexical.generation_id);
});

it("keeps reduced-allocation exhaustion after vector cursor progress partial and resumes normally", async () => {
  const h = fixture(); databases.push(h.database);
  h.database.connection.prepare("DELETE FROM workspaces WHERE workspace_id=?").run("workspace-2");
  publishSource(h, "first", "a"); publishSource(h, "second", "b");
  const warn = vi.fn(), producer = new SourceIndexProducer({ database: h.database, warn,
    limits: { capturePage: 1, maxWorkspacesPerPass: 1 }, bindSourceEmbedding: async options => {
      const profile = configuration({ max_input_tokens: 32, window_bytes: options.window_bytes }).profile;
      return { status: "ready", profile, profile_id: sourceIndexProfileId(profile, fieldSha256),
        embedInputs: async inputs => inputs.map(input => ({ status: "embedded", input_id: input.input_id,
          input_digest: hashContentDigest(input.text, fieldSha256), vector: new Float32Array([0.6, 0.8, 0]),
          token_count: 2, truncated: false })) };
    } });
  producers.push(producer);
  expect(await producer.runLexicalPass(WORKSPACE, "raw-unicode61.v1")).toMatchObject({ status: "ready" });
  const partial = await producer.runPass({ work: 330 });
  expect(partial).toMatchObject({ status: "partial", reason: "enumeration_budget", capture_pages: 2, visited_roots: 0 });
  expect(warn).not.toHaveBeenCalled();
  const state = h.index.state(WORKSPACE);
  expect(state).toMatchObject({ status: "partial", active_generation_id: null });
  expect(await producer.runPass()).toMatchObject({ status: "settled" });
  expect(h.index.state(WORKSPACE)).toMatchObject({ status: "ready" });
});

it("does not overwrite lexical allocation exhaustion with an unsupported binding outcome", async () => {
  const h = fixture(); databases.push(h.database); publishSource(h, "retained root");
  const warn = vi.fn(), producer = new SourceIndexProducer({ database: h.database, warn,
    bindSourceEmbedding: async () => ({ status: "unsupported", reason: "fixture_unbound" }), limits: { maxWorkspacesPerPass: 1 } });
  producers.push(producer);
  expect(await producer.runPass({ work: 200 })).toMatchObject({ status: "resource_exhausted",
    reason: "enumeration_allocation_exhausted", binding: { status: "unsupported", reason: "fixture_unbound" } });
  expect(warn).toHaveBeenCalledWith("source index lexical preparation unavailable", expect.objectContaining({ reason: "enumeration_allocation_exhausted" }));
});
