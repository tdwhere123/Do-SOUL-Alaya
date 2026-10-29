import { afterEach, expect, it, vi } from "vitest";
import { SourceIndexLifecycle } from "@do-soul/alaya-core";
import { SOURCE_INDEX_MAX_BODY_BYTES, captureSourceIndexLexicalPreparationAllocation } from "@do-soul/alaya-protocol";
import { lexicalDomainTables } from "../../../../../../packages/storage/src/repos/source-index/lexical-domain.js";
import { fixture, publishSource, WORKSPACE, fieldSha256, type Fixture } from
  "../../../../../../packages/storage/src/__tests__/repos/source-index/source-index-fixture.js";
import { createSourceIndexProducer, type SourceIndexProducer } from
  "../../../runtime/source-index/source-index-producer.js";

const environments: Fixture[] = [], producers: SourceIndexProducer[] = [];
afterEach(async () => {
  for (const producer of producers.splice(0)) await producer.stop();
  for (const environment of environments.splice(0)) environment.database.close({ optimize: false });
  vi.restoreAllMocks();
});
function input() {
  const environment = fixture(); environments.push(environment);
  const body = "stone ".repeat(12984) + "x";
  expect(body.length).toBe(77905);
  publishSource(environment, body);
  return environment;
}
function projection(environment: Fixture, generationId: string) {
  const table = lexicalDomainTables(generationId).unicode61;
  return {
    rows: environment.database.connection.prepare(`SELECT content_digest,body_bytes,projection FROM source_index_lexical_projections
      WHERE workspace_id=? AND generation_id=?`).all(WORKSPACE, generationId),
    stone_hits: environment.database.connection.prepare(`SELECT rowid FROM ${table} WHERE ${table} MATCH 'stone'`).all(),
    absent_hits: environment.database.connection.prepare(`SELECT rowid FROM ${table} WHERE ${table} MATCH 'absent'`).all()
  };
}

it("funds an atomic v1 document explicitly while preserving default and remaining work restrictions", async () => {
  const environment = input();
  const bindSourceEmbedding = vi.fn(async () => ({ status: "unsupported" as const, reason: "model_forbidden" }));
  const producer = createSourceIndexProducer({ database: environment.database, bindSourceEmbedding, warn: vi.fn() });
  producers.push(producer);
  const observed = vi.spyOn(SourceIndexLifecycle.prototype, "prepareLexical");
  for (let attempt = 0; attempt < 2; attempt++) {
    const refused = await producer.runLexicalPass(WORKSPACE, "segmented-unicode61.v1");
    expect(refused).toMatchObject({ status: "partial", reason: "read_budget", model_inputs: 0,
      generation: { completed_count: 0, target_count: 1, enumeration_complete: true } });
    expect(refused).not.toHaveProperty("preparation_allocation");
    expect(observed.mock.calls.at(-1)![2]).toMatchObject({ work: 50000, native_bytes: 4194304,
      max_body_bytes: SOURCE_INDEX_MAX_BODY_BYTES, max_roots: 16, max_capture_pages: 16 });
  }
  const restricted = await producer.runLexicalPass(WORKSPACE, "segmented-unicode61.v1", { work: 50000 }, { work: 131072 });
  expect(restricted).toMatchObject({ status: "partial", reason: "read_budget", model_inputs: 0,
    preparation_allocation: { requested_work: 131072, effective_work: 50000 }, generation: { completed_count: 0 } });
  const allocation = { work: 131072 };
  const pending = producer.runLexicalPass(WORKSPACE, "segmented-unicode61.v1", undefined, allocation);
  allocation.work = 1;
  const ready = await pending;
  expect(ready).toMatchObject({ status: "ready", reason: null, model_inputs: 0,
    preparation_allocation: { requested_work: 131072, effective_work: 131072 }, generation: { completed_count: 1 } });
  expect(ready.resources.work).toBeGreaterThan(77905); expect(ready.resources.work).toBeLessThanOrEqual(131072);
  expect(observed.mock.calls.at(-1)![2]).toMatchObject({ work: 131072, native_bytes: 4194304,
    max_body_bytes: SOURCE_INDEX_MAX_BODY_BYTES, max_roots: 16, max_capture_pages: 16 });
  expect(bindSourceEmbedding).not.toHaveBeenCalled();

  const control = input();
  const reference = await new SourceIndexLifecycle(control.index, fieldSha256).prepareLexical(WORKSPACE, "segmented-unicode61.v1", {
    work: 131072, native_bytes: 4194304, capture_page: 32, max_capture_pages: 16, max_roots: 16,
    max_body_bytes: SOURCE_INDEX_MAX_BODY_BYTES
  });
  expect(reference.status).toBe("ready");
  expect(projection(environment, ready.generation!.generation_id)).toEqual(projection(control, reference.generation!.generation_id));
  const actual = projection(environment, ready.generation!.generation_id);
  expect(actual.stone_hits).toHaveLength(1); expect(actual.absent_hits).toEqual([]);
  // A new root must still obey the persistent default after the explicit call.
  publishSource(environment, "stone ".repeat(12984) + "x", "new-source");
  const again = await producer.runLexicalPass(WORKSPACE, "segmented-unicode61.v1");
  expect(again).toMatchObject({ status: "partial", reason: "read_budget", model_inputs: 0 });
  expect(observed.mock.calls.at(-1)![2].work).toBe(50000); expect(bindSourceEmbedding).not.toHaveBeenCalled();
});

it("rejects invalid lexical allocations before starting a model-free pass", async () => {
  const environment = input(), bind = vi.fn(async () => ({ status: "unsupported" as const, reason: "model_forbidden" }));
  const producer = createSourceIndexProducer({ database: environment.database, bindSourceEmbedding: bind, warn: vi.fn() });
  producers.push(producer);
  for (const value of [null, {}, [], { work: 0 }, { work: -1 }, { work: 1.5 }, { work: Infinity },
    { work: Number.MAX_SAFE_INTEGER + 1 }, { work: 131072, nativeBytes: 8388608 }]) {
    expect(() => captureSourceIndexLexicalPreparationAllocation(value)).toThrow(/invalid Source lexical preparation allocation/u);
    await expect(producer.runLexicalPass(WORKSPACE, "segmented-unicode61.v1", undefined, value as never))
      .rejects.toThrow(/invalid Source lexical preparation allocation/u);
  }
  expect(environment.index.lexical.lexicalState(WORKSPACE)).toBeNull(); expect(bind).not.toHaveBeenCalled();
});

it("preserves producer occupancy and stop refusal for an explicit lexical allocation", async () => {
  const environment = input(), bind = vi.fn(async () => ({ status: "unsupported" as const, reason: "model_forbidden" }));
  const producer = createSourceIndexProducer({ database: environment.database, bindSourceEmbedding: bind, warn: vi.fn() });
  producers.push(producer);
  const running = producer.runLexicalPass(WORKSPACE, "segmented-unicode61.v1", undefined, { work: 131072 });
  await expect(producer.runLexicalPass(WORKSPACE, "segmented-unicode61.v1", undefined, { work: 131072 }))
    .rejects.toThrow(/producer_occupied/u);
  await running; await producer.stop();
  await expect(producer.runLexicalPass(WORKSPACE, "segmented-unicode61.v1", undefined, { work: 131072 }))
    .rejects.toThrow(/producer_stopped/u);
  expect(bind).not.toHaveBeenCalled();
});
