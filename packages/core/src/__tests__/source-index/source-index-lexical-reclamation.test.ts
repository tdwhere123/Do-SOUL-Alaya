import { afterEach, expect, it, vi } from "vitest";
import { SourceIndexLifecycle } from "../../source-index/source-index-lifecycle.js";
import { BUDGET, WORKSPACE, fieldSha256, fixture, publishSource, type Fixture } from
  "../../../../storage/src/__tests__/repos/source-index/source-index-fixture.js";

const environments: Fixture[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const environment of environments.splice(0)) environment.database.close({ optimize: false });
});
const limits = { ...BUDGET, capture_page: 2, max_capture_pages: 8, max_roots: 8, max_body_bytes: 65536 };
async function setup() {
  const environment = fixture(); environments.push(environment);
  for (const id of ["first", "second", "third"]) publishSource(environment, "stable alpha", id);
  const lifecycle = new SourceIndexLifecycle(environment.index, fieldSha256);
  const prior = await lifecycle.prepareLexical(WORKSPACE, "raw-unicode61.v1", limits);
  publishSource(environment, "new beta", "fourth");
  const active = await lifecycle.prepareLexical(WORKSPACE, "raw-unicode61.v1", limits);
  expect(prior.status).toBe("ready"); expect(active.status).toBe("ready");
  return { ...environment, lifecycle, prior: prior.generation!.generation_id, active: active.generation!.generation_id };
}

it("debits committed reclamation pages and resumes them after cancellation without reopening a retired generation", async () => {
  const { lifecycle, index, prior, active } = await setup();
  const stop = new AbortController(), reclaim = index.lexical.reclaimLexicalPage.bind(index.lexical);
  vi.spyOn(index.lexical, "reclaimLexicalPage").mockImplementationOnce((...args) => {
    const result = reclaim(...args); stop.abort(); return result;
  });
  const interrupted = await lifecycle.prepareLexical(WORKSPACE, "raw-unicode61.v1", limits, stop.signal);
  expect(interrupted).toMatchObject({ status: "partial", reason: "cancelled", accounting: "complete",
    capture_pages: 0, visited_roots: 0, reclamation: { pages: 1, projections: 2, targets: 0, generations: 0 } });
  expect(interrupted.resources.work).toBeGreaterThan(0);
  expect(index.lexical.lexicalGeneration(WORKSPACE, prior)?.status).toBe("retired");
  expect(index.lexical.lexicalState(WORKSPACE)?.active_generation_id).toBe(active);
  const resumed = await lifecycle.prepareLexical(WORKSPACE, "raw-unicode61.v1", limits);
  expect(resumed).toMatchObject({ status: "ready", visited_roots: 0, capture_pages: 0,
    reclamation: { projections: 1, targets: 3, generations: 1 } });
  expect(index.lexical.lexicalGeneration(WORKSPACE, prior)).toBeNull();
  expect(index.lexical.lexicalGeneration(WORKSPACE, active)?.status).toBe("ready");
});

it("bounds maintenance by the existing pass work and pages while preserving the ready result", async () => {
  const { lifecycle, index, prior } = await setup();
  const costs = vi.spyOn(index.lexical, "reclaimLexicalPage");
  const first = await lifecycle.prepareLexical(WORKSPACE, "raw-unicode61.v1", { ...limits, max_capture_pages: 1, work: 6 });
  expect(first).toMatchObject({ status: "ready", capture_pages: 0, visited_roots: 0,
    reclamation: { pages: 1, projections: 1, targets: 0, generations: 0 } });
  expect(first.resources.work).toBeLessThanOrEqual(6);
  expect(first.resources).toEqual(costs.mock.results[0]!.value.resources);
  expect(index.lexical.lexicalGeneration(WORKSPACE, prior)?.status).toBe("retired");
  const noWork = await lifecycle.prepareLexical(WORKSPACE, "raw-unicode61.v1", { ...limits, work: 0 });
  expect(noWork).toMatchObject({ status: "ready", resources: { work: 0, native_bytes: 0 },
    reclamation: { pages: 0, projections: 0, targets: 0, generations: 0 } });
});
