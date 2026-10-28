import { afterEach, expect, it, vi } from "vitest";
import { SourceIndexOperationError } from "@do-soul/alaya-protocol";
import { SourceIndexLifecycle } from "../../source-index/source-index-lifecycle.js";
import { BUDGET, WORKSPACE, fieldSha256, fixture, publishSource, type Fixture } from
  "../../../../storage/src/__tests__/repos/source-index/source-index-fixture.js";

const environments: Fixture[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const environment of environments.splice(0)) environment.database.close({ optimize: false });
});
const limits = { ...BUDGET, capture_page: 8, max_capture_pages: 4, max_roots: 8, max_body_bytes: 65536 };
function setup() {
  const environment = fixture(); environments.push(environment);
  publishSource(environment, "first stable root", "first");
  publishSource(environment, "second stable root", "second");
  return { ...environment, lifecycle: new SourceIndexLifecycle(environment.index, fieldSha256) };
}

it("retains nested operation costs and separately owned root visits", () => {
  const inner = new SourceIndexOperationError(new Error("copy failed"), { work: 3, native_bytes: 8 }, 2, 2);
  const outer = new SourceIndexOperationError(inner, { work: 1, native_bytes: 4 }, 1, 1);
  expect(outer).toMatchObject({ cause: inner, resources: { work: 4, native_bytes: 12 }, visited_roots: 3, analysis_units: 3 });
  expect(new SourceIndexOperationError(inner, { work: 0, native_bytes: 0 }).visited_roots).toBe(2);
});

it("counts attempted lexical roots on refusal and resumes without inventing visits or capture pages", async () => {
  const { lifecycle } = setup();
  const refused = await lifecycle.prepareLexical(WORKSPACE, "raw-unicode61.v1", { ...limits, max_body_bytes: 0 });
  expect(refused).toMatchObject({ status: "partial", visited_roots: 1, capture_pages: 1,
    generation: { completed_count: 0, enumeration_complete: true } });
  expect(refused.resources.work).toBeGreaterThan(0);
  const first = await lifecycle.prepareLexical(WORKSPACE, "raw-unicode61.v1", { ...limits, max_roots: 1 });
  expect(first).toMatchObject({ status: "partial", visited_roots: 1, capture_pages: 0,
    generation: { completed_count: 1 } });
  const second = await lifecycle.prepareLexical(WORKSPACE, "raw-unicode61.v1", { ...limits, max_roots: 1 });
  expect(second).toMatchObject({ status: "ready", visited_roots: 1, capture_pages: 0,
    generation: { completed_count: 2 } });
  expect(await lifecycle.prepareLexical(WORKSPACE, "raw-unicode61.v1", limits))
    .toMatchObject({ status: "ready", visited_roots: 0, capture_pages: 0 });
});

it("bounds copied roots by the same visit allowance and debits their real costs", async () => {
  const environment = setup(), { lifecycle, index } = environment;
  await lifecycle.prepareLexical(WORKSPACE, "raw-unicode61.v1", limits);
  publishSource(environment, "new epoch root", "third");
  const operations = ["captureLexicalPage", "reuseLexicalProjections", "pendingLexicalTarget",
    "readLexicalDocument", "writeLexicalDocument", "reclaimLexicalPage"] as const;
  const calls = operations.map(name => vi.spyOn(index.lexical, name));
  const copy = await lifecycle.prepareLexical(WORKSPACE, "raw-unicode61.v1", { ...limits, max_roots: 1 });
  expect(copy).toMatchObject({ status: "partial", visited_roots: 1, capture_pages: 1, analysis_units: 0,
    generation: { target_count: 3, completed_count: 1 } });
  expect(calls[1]).toHaveBeenCalledExactlyOnceWith(WORKSPACE, copy.generation!.generation_id, 1, expect.any(Object));
  expect(calls[3]).not.toHaveBeenCalled();
  const costs = calls.flatMap(call => call.mock.results.filter(result => result.type === "return").map(result => result.value.resources));
  expect(copy.resources).toEqual({ work: costs.reduce((sum, cost) => sum + cost.work, 0),
    native_bytes: costs.reduce((sum, cost) => sum + cost.native_bytes, 0) });
  expect(index.lexical.reuseLexicalProjections(WORKSPACE, copy.generation!.generation_id, 1,
    { work: 0, native_bytes: BUDGET.native_bytes })).toEqual({ reused: 0, complete: false,
    resources: { work: 0, native_bytes: 0 } });
  for (let pass = 0; pass < 2; pass++) {
    expect(await lifecycle.prepareLexical(WORKSPACE, "raw-unicode61.v1", { ...limits, max_roots: 1 }))
      .toMatchObject({ visited_roots: 1, capture_pages: 0 });
  }
  expect(await lifecycle.prepareLexical(WORKSPACE, "raw-unicode61.v1", limits)).toMatchObject({ status: "ready",
    visited_roots: 0, capture_pages: 0, reclamation: { projections: 2, targets: 2, generations: 1 } });
});

it("retains attempted copy visits across transaction rollback and resumes from durable pending roots", async () => {
  const environment = setup(), { lifecycle, index, database } = environment;
  await lifecycle.prepareLexical(WORKSPACE, "raw-unicode61.v1", limits);
  publishSource(environment, "new epoch root", "third");
  const generation = index.lexical.beginLexical(index.lexical.selectLexical(WORKSPACE, "raw-unicode61.v1"));
  index.lexical.captureLexicalPage(WORKSPACE, generation.generation_id, 8, BUDGET);
  // Fail the second copied projection after the first copy consumed work; SQLite rolls back both.
  database.connection.exec(`CREATE TEMP TRIGGER refuse_second_lexical_copy BEFORE INSERT ON source_index_lexical_projections
    WHEN (SELECT count(*) FROM source_index_lexical_projections WHERE generation_id=NEW.generation_id)=1
    BEGIN SELECT RAISE(ABORT, 'authored copy failure'); END`);
  const failed = await lifecycle.prepareLexical(WORKSPACE, "raw-unicode61.v1", { ...limits, max_roots: 2 });
  expect(failed).toMatchObject({ status: "unavailable", accounting: "lower_bound", reason: "authored copy failure",
    visited_roots: 2, capture_pages: 0, resources: { work: 4 } });
  expect(failed.resources.native_bytes).toBeGreaterThan(0);
  expect(index.lexical.lexicalGeneration(WORKSPACE, generation.generation_id)).toMatchObject({ completed_count: 0 });
  database.connection.exec("DROP TRIGGER refuse_second_lexical_copy");
  const resumed = await lifecycle.prepareLexical(WORKSPACE, "raw-unicode61.v1", { ...limits, max_roots: 2 });
  expect(resumed).toMatchObject({ status: "partial", accounting: "complete", visited_roots: 2, capture_pages: 0,
    analysis_units: 0, generation: { completed_count: 2 } });
});

it("counts a failed census call without inventing root visits and retries its rolled-back page", async () => {
  const { lifecycle, index, database } = setup();
  database.connection.exec(`CREATE TEMP TRIGGER refuse_lexical_capture BEFORE INSERT ON source_index_lexical_targets
    BEGIN SELECT RAISE(ABORT, 'authored capture failure'); END`);
  const failed = await lifecycle.prepareLexical(WORKSPACE, "raw-unicode61.v1", limits);
  expect(failed).toMatchObject({ status: "unavailable", accounting: "lower_bound", visited_roots: 0, capture_pages: 1 });
  expect(failed.resources.work).toBeGreaterThan(0);
  expect(index.lexical.lexicalGeneration(WORKSPACE, failed.generation!.generation_id))
    .toMatchObject({ target_count: 0, completed_count: 0, enumeration_complete: false });
  database.connection.exec("DROP TRIGGER refuse_lexical_capture");
  expect(await lifecycle.prepareLexical(WORKSPACE, "raw-unicode61.v1", limits))
    .toMatchObject({ status: "ready", visited_roots: 2, capture_pages: 1 });
});

it("keeps the attempted root and real read cost when a native operation fails after reading", async () => {
  const { lifecycle, index } = setup();
  const read = index.lexical.readLexicalDocument.bind(index.lexical);
  const reclaim = vi.spyOn(index.lexical, "reclaimLexicalPage");
  const capture = vi.spyOn(index.lexical, "captureLexicalPage");
  const pending = vi.spyOn(index.lexical, "pendingLexicalTarget");
  let readCost = { work: 0, native_bytes: 0 };
  vi.spyOn(index.lexical, "readLexicalDocument").mockImplementationOnce((...args) => {
    const result = read(...args); readCost = result.resources;
    throw new SourceIndexOperationError(new Error("authored failure after native read"), readCost);
  });
  const failed = await lifecycle.prepareLexical(WORKSPACE, "raw-unicode61.v1", limits);
  expect(failed).toMatchObject({ status: "unavailable", accounting: "lower_bound", visited_roots: 1, capture_pages: 1 });
  expect(readCost.work).toBeGreaterThan(0);
  const costs = [reclaim.mock.results[0]!.value.resources, capture.mock.results[0]!.value.resources,
    pending.mock.results[0]!.value.resources, readCost];
  expect(failed.resources).toEqual({ work: costs.reduce((sum, cost) => sum + cost.work, 0),
    native_bytes: costs.reduce((sum, cost) => sum + cost.native_bytes, 0) });
  expect(await lifecycle.prepareLexical(WORKSPACE, "raw-unicode61.v1", limits))
    .toMatchObject({ status: "ready", accounting: "complete", visited_roots: 2, capture_pages: 0 });
});
