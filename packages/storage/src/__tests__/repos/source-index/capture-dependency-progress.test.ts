import { afterEach, expect, it } from "vitest";
import { BUDGET, WORKSPACE, configuration, fixture, publishSource, type Fixture } from "./source-index-fixture.js";
import { publishFullContextStatement } from "./source-template-fixture.js";
import { readStatementDependencies } from "../../../repos/source-index/statement-dependencies.js";

const environments: Fixture[] = [];
afterEach(() => { for (const h of environments.splice(0)) h.database.close({ optimize: false }); });

it.each([320, 800])("reports an unserviceable %i-work census allocation without losing the root or failing the generation", async work => {
  const h = fixture(); environments.push(h);
  const { first, later } = await publishFullContextStatement(h);
  const targets = (id: string) => {
    const page = h.index.listTargets(WORKSPACE, id, null, 128);
    return [...page, ...h.index.listTargets(WORKSPACE, id, page.at(-1)!.root_key, 128)];
  };
  const dependency = readStatementDependencies(h.database, WORKSPACE, first.source.auxiliary!.artifact_id, BUDGET);
  expect(dependency).toEqual({ status: "ready", resources: { work: 517, native_bytes: 16 } });
  const generation = h.index.begin(h.index.select(WORKSPACE, configuration()));
  // 129 raw records plus the end-of-records visit; capsule enumeration is next pass.
  h.index.capturePage(WORKSPACE, generation.generation_id, 128, BUDGET);
  const rawEnd = h.index.capturePage(WORKSPACE, generation.generation_id, 2, BUDGET);
  expect(rawEnd.generation.records_complete).toBe(true);
  expect(rawEnd.generation.after_capsule_cursor).toBeNull();
  const small = { work, native_bytes: BUDGET.native_bytes };
  for (let pass = 0; pass < 3; pass++) {
    const captured = h.index.capturePage(WORKSPACE, generation.generation_id, 8, small);
    expect(captured.generation).toMatchObject({ status: "partial", reason: "enumeration_allocation_exhausted",
      enumeration_complete: false, after_capsule_cursor: null, generation_id: generation.generation_id, target_count: 129 });
    expect(captured.resources.work).toBeGreaterThan(0);
    expect(captured.resources.work).toBeLessThanOrEqual(work);
    expect(captured.resources.native_bytes).toBeLessThanOrEqual(small.native_bytes);
    expect(targets(generation.generation_id).some(target => target.auxiliary !== undefined || target.target.root_id === later.object_id)).toBe(false);
    expect(h.index.activate(WORKSPACE, generation.generation_id)).toMatchObject({ status: "rejected", reason: "incomplete" });
  }
  const captured = h.index.capturePage(WORKSPACE, generation.generation_id, 8,
    { work: 25_000, native_bytes: 2 * 1024 * 1024 });
  expect(captured.generation).toMatchObject({ generation_id: generation.generation_id, enumeration_complete: true, status: "building" });
  const recovered = targets(generation.generation_id);
  expect(recovered.map(target => target.root_key)).toContain(first.source.root_key);
  expect(recovered.some(target => target.target.root_id === later.object_id)).toBe(true);
  expect(recovered).toHaveLength(131);
  expect(h.index.pendingWindows(WORKSPACE, generation.generation_id, first.source.root_key, 1, BUDGET))
    .toMatchObject({ status: "partial", reason: "manifest_unprepared" });
});

it("distinguishes remaining-budget exhaustion after durable progress from an unserviceable allocation", () => {
  const h = fixture(); environments.push(h);
  for (let index = 0; index < 3; index++) publishSource(h, "small root", `source-${index}`);
  const generation = h.index.begin(h.index.select(WORKSPACE, configuration()));
  const first = h.index.capturePage(WORKSPACE, generation.generation_id, 8, { work: 320, native_bytes: BUDGET.native_bytes });
  expect(first.generation).toMatchObject({ reason: "enumeration_budget", enumeration_complete: false, target_count: 1 });
  expect(first.generation.after_source_id).not.toBeNull();
  const second = h.index.capturePage(WORKSPACE, generation.generation_id, 1, BUDGET);
  expect(second.generation).toMatchObject({ reason: "enumeration_page", target_count: 2 });
  expect(second.generation.after_source_id).not.toBe(first.generation.after_source_id);
  const last = h.index.capturePage(WORKSPACE, generation.generation_id, 8, BUDGET);
  expect(last.generation).toMatchObject({ enumeration_complete: true, target_count: 3 });
});
