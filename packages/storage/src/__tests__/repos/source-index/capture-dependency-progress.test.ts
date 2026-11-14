import { afterEach, expect, it } from "vitest";
import { BUDGET, WORKSPACE, configuration, fixture, type Fixture } from "./source-index-fixture.js";
import { contextOf, publishMessages, publishStatement } from "./source-template-fixture.js";
import { readStatementDependencies } from "../../../repos/source-index/statement-dependencies.js";

const environments: Fixture[] = [];
afterEach(() => { for (const h of environments.splice(0)) h.database.close({ optimize: false }); });

it("keeps oversized statement dependencies partial at the same cursor, then captures it and later roots with a larger pass", () => {
  const h = fixture(); environments.push(h);
  const contexts = Array.from({ length: 128 }, (_, index) =>
    publishMessages(h, [{ role: "user", text: `Context ${index}.` }], `context-${String(index).padStart(3, "0")}`).record);
  const source = publishMessages(h, [{ role: "user", text: "The dependent statement." }], "target");
  // These fixed labels yield UUIDs 3e23… then ca97… at the same retained clock.
  const first = publishStatement(h, source, "b", 0, {}, contexts.map(contextOf));
  const later = publishStatement(h, source, "a");
  expect(first.source.auxiliary!.artifact_id < later.source.auxiliary!.artifact_id).toBe(true);
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
  const small = { work: 320, native_bytes: BUDGET.native_bytes };
  for (let pass = 0; pass < 2; pass++) {
    const captured = h.index.capturePage(WORKSPACE, generation.generation_id, 8, small);
    expect(captured.generation).toMatchObject({ status: "partial", reason: "enumeration_budget",
      enumeration_complete: false, after_capsule_cursor: null });
    expect(captured.resources.work).toBeLessThanOrEqual(320);
    expect(captured.resources.native_bytes).toBeLessThanOrEqual(small.native_bytes);
    expect(targets(generation.generation_id)
      .some(target => target.auxiliary !== undefined)).toBe(false);
    expect(h.index.pendingWindows(WORKSPACE, generation.generation_id, later.source.root_key, 1, BUDGET))
      .toMatchObject({ status: "unbound", reason: "missing_target" });
  }
  // The default producer's half-pass lexical allocation is sufficient, without
  // increasing a small caller's allowance or changing generation meaning.
  const captured = h.index.capturePage(WORKSPACE, generation.generation_id, 8,
    { work: 25_000, native_bytes: 2 * 1024 * 1024 });
  expect(captured.generation.enumeration_complete).toBe(true);
  expect(captured.generation.status).not.toBe("failed");
  const keys = targets(generation.generation_id).map(target => target.root_key);
  expect(keys).toContain(first.source.root_key); expect(keys).toContain(later.source.root_key);
  for (const target of [first, later]) {
    expect(h.index.pendingWindows(WORKSPACE, generation.generation_id, target.source.root_key, 1, BUDGET))
      .toMatchObject({ status: "partial", reason: "manifest_unprepared" });
  }
  expect(h.index.activate(WORKSPACE, generation.generation_id)).toMatchObject({ status: "rejected", reason: "incomplete" });
});
