import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const url = new URL("../../../../../../packages/core/src/__tests__/embedding-recall/authored-source-embedding-guard.mjs", import.meta.url);
  return (await import(/* @vite-ignore */ url.href)).isolation;
});
afterAll(() => { expect(isolation.violations).toEqual([]); isolation.restore(); });
import { __resetCjkSegmentationStateForTests, readCjkSegmentationStatus } from "@do-soul/alaya-cjk-segmentation";
import { SqliteSourceIndexLexicalStore } from "../../../../../../packages/storage/src/repos/source-index/lexical-generation.js";
import { fixture, publishSource, WORKSPACE } from "../../../../../../packages/storage/src/__tests__/repos/source-index/source-index-fixture.js";
import { SourceIndexProducer } from "../../../runtime/source-index/source-index-producer.js";

afterEach(() => { vi.restoreAllMocks(); __resetCjkSegmentationStateForTests(); });
const body = "自动部署流水线";
function setup() {
  const environment = fixture();
  publishSource(environment, body, "first"); publishSource(environment, body, "second");
  const bind = vi.fn(async () => { throw new Error("lexical pass must not bind a model"); });
  const createProducer = () => new SourceIndexProducer({ database: environment.database,
    bindSourceEmbedding: bind, warn: vi.fn(), limits: { stepDeadlineMs: 1000 } });
  return { ...environment, bind, createProducer };
}

it("refuses publication after a raw native write crosses the deadline before any queued callback can run", async () => {
  __resetCjkSegmentationStateForTests();
  const { database, index, bind, createProducer } = setup(), producer = createProducer();
  let now = Date.now(), callbackRan = false, callback: Promise<void> | undefined;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const original = SqliteSourceIndexLexicalStore.prototype.writeLexicalDocument;
  const write = vi.spyOn(SqliteSourceIndexLexicalStore.prototype, "writeLexicalDocument").mockImplementation(function (this: SqliteSourceIndexLexicalStore, ...args) {
    const result = original.apply(this, args);
    now += 1001; // Authored clock advancement inside the actual bounded native collaborator; no fake timers.
    callback = new Promise(resolve => setImmediate(() => { callbackRan = true; resolve(); }));
    return result;
  });
  const activate = vi.spyOn(SqliteSourceIndexLexicalStore.prototype, "activateLexical");
  try {
    const result = await producer.runLexicalPass(WORKSPACE, "raw-unicode61.v1");
    expect(callbackRan).toBe(false);
    expect(result).toMatchObject({ status: "partial", reason: "deadline_exceeded", accounting: "complete",
      analysis_units: 0, model_inputs: 0, visited_roots: 1, capture_pages: 1 });
    expect(result.resources.work).toBeGreaterThan(0);
    expect(result.resources.native_bytes).toBeGreaterThan(0);
    expect(write).toHaveBeenCalledTimes(1); expect(activate).not.toHaveBeenCalled();
    expect(index.lexical.lexicalState(WORKSPACE)?.active_generation_id).toBeNull();
    expect(index.lexical.lexicalGeneration(WORKSPACE, result.generation!.generation_id))
      .toMatchObject({ enumeration_complete: true, target_count: 2, completed_count: 1 });
    expect(readCjkSegmentationStatus()).toBe("uninitialized");
    expect(bind).not.toHaveBeenCalled();
  } finally { await callback; await producer.stop(); database.close({ optimize: false }); }
});

it("admits queued stop between segmented roots, retains occupancy and durable work, and resumes on a healthy producer", async () => {
  const { database, index, bind, createProducer } = setup(), producer = createProducer();
  vi.spyOn(Date, "now").mockReturnValue(Date.now()); // Cancellation is tested independently of elapsed CPU time.
  let writes = 0, passSettled = false, settledWhenStopStarted: boolean | undefined;
  let stopSettled = false, settledInsideStopCallback: boolean | undefined, stop: Promise<void> | undefined;
  let passSettledWhenStopResolved: boolean | undefined;
  const original = SqliteSourceIndexLexicalStore.prototype.writeLexicalDocument;
  const write = vi.spyOn(SqliteSourceIndexLexicalStore.prototype, "writeLexicalDocument").mockImplementation(function (this: SqliteSourceIndexLexicalStore, ...args) {
    const result = original.apply(this, args);
    if (++writes === 1) setImmediate(() => {
      settledWhenStopStarted = passSettled;
      stop = producer.stop().then(() => { stopSettled = true; passSettledWhenStopResolved = passSettled; });
      settledInsideStopCallback = stopSettled;
    });
    return result;
  });
  const activate = vi.spyOn(SqliteSourceIndexLexicalStore.prototype, "activateLexical");
  let resumedProducer: SourceIndexProducer | undefined;
  try {
    const pass = producer.runLexicalPass(WORKSPACE, "segmented-unicode61.v1");
    void pass.then(() => { passSettled = true; });
    const interrupted = await pass;
    expect(settledWhenStopStarted).toBe(false); expect(settledInsideStopCallback).toBe(false);
    expect(interrupted).toMatchObject({ status: "partial", reason: "cancelled", accounting: "complete",
      analysis_units: body.length, model_inputs: 0, visited_roots: 1, capture_pages: 1 });
    expect(interrupted.resources.work).toBeGreaterThan(body.length);
    expect(interrupted.resources.native_bytes).toBeGreaterThan(0);
    expect(write).toHaveBeenCalledTimes(1); expect(activate).not.toHaveBeenCalled();
    expect(index.lexical.lexicalState(WORKSPACE)?.active_generation_id).toBeNull();
    expect(index.lexical.lexicalGeneration(WORKSPACE, interrupted.generation!.generation_id))
      .toMatchObject({ target_count: 2, completed_count: 1 });
    await stop; expect(stopSettled).toBe(true); expect(passSettledWhenStopResolved).toBe(true);
    resumedProducer = createProducer();
    const resumed = await resumedProducer.runLexicalPass(WORKSPACE, "segmented-unicode61.v1");
    expect(resumed).toMatchObject({ status: "ready", analysis_units: body.length, generation: {
      generation_id: interrupted.generation!.generation_id, status: "ready", target_count: 2, completed_count: 2 } });
    expect(write).toHaveBeenCalledTimes(2); expect(activate).toHaveBeenCalledTimes(1);
    expect(bind).not.toHaveBeenCalled();
  } finally { await producer.stop(); await resumedProducer?.stop(); database.close({ optimize: false }); }
});
