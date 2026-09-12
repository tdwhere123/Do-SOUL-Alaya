import { describe, expect, it } from "vitest";
import { memoryRecallTarget, type Guard, type QueryProgram, type TypedObservation } from "@do-soul/alaya-protocol";
import { BindingContextStore, BindingContextResourceError, BindingContextUnavailableError,
  encodeBindingContext, parseBindingContext, evaluateGuard } from "../../../../recall/conditional-field/engine/binding-environment.js";
import { adjacencyEffectsForRows, seedActivationsForObservation } from "../../../../recall/conditional-field/engine/path-composition.js";
import { compileConditionalFieldQuery } from "../../../../recall/conditional-field/query/compile-query.js";
import { buildTypedObservation, sourceRowEligible, relationRowEligible } from "../../../../recall/conditional-field/observers/observation-admission.js";
import { startObserverCursor, type ObserveConditionalFieldInput } from "../../../../recall/conditional-field/observers/observe.js";
import { defaultBudget, SNAPSHOT_ID, INTERPRETATION_CLOCK } from "../reference/deployment.fixture.js";

const interval = { start: "2026-09-09T00:00:00Z", end: "2026-09-09T00:00:01Z", time_domain: "event_time" as const };
const timeGuard: Guard = { schema_version: 1, kind: "interval_relation", variable: "y", verdict: "unresolved", time_scope: "associated", interval };
const relation = (guard: Guard): QueryProgram => ({ schema_version: 1, kind: "relation", relation_kind: "observed_log",
  source_variable: "x", target_variable: "y", guard, facet_mode: "same_path", threshold_milligrades: 0 });

function compile(program: QueryProgram) {
  return compileConditionalFieldQuery({ source: "typed", snapshot_id: SNAPSHOT_ID, budget: defaultBudget(), program,
    interpretation_clock: INTERPRETATION_CLOCK, authorized_scopes: null });
}

function observation(objectId: string): TypedObservation {
  return { schema_version: 1, observation_id: `seed:${objectId}`, object_id: objectId, source_revision: "rev", workspace_id: "ws",
    target: memoryRecallTarget({ workspace_id: "ws", object_id: objectId, source_revision: "rev" }),
    applicability: { schema_version: 1, kind: "query_predicate", verdict: "true" }, association_milligrades: 1000 };
}

function observerInput(guard: Guard): ObserveConditionalFieldInput {
  const query = compile(relation(guard));
  return { query, workspace_id: "ws", authorized_scopes: null, readers: {},
    lease: { schema_version: 1, lease_id: "lease", snapshot_id: SNAPSHOT_ID, query_id: query.query_id, status: "active" },
    action: { schema_version: 1, action: "adjacency", region_id: "adjacency", work_limit: 20 },
    cursor: startObserverCursor({ cursor_id: "adjacency", snapshot_id: SNAPSHOT_ID, query_id: query.query_id, region_id: "adjacency" }) };
}

describe("binding and temporal semantic identity", () => {
  it.each([
    { schema_version: 1, kind: "authorization", verdict: "unresolved", authorization_scope: "project" },
    { schema_version: 1, kind: "query_predicate", verdict: "unresolved", predicate_name: "source.literal.nfc.v1", entity_id: "needle" }
  ] satisfies Guard[])("keeps an explicit missing binding unresolved for $kind", (guard) => {
    const facts = new Map([["end", { object_id: "end", scope_class: "project", content: "needle" }]]);
    const env = new Map([["x", "seed"], ["y", "end"]]);
    const endpoints = { sourceId: "seed", targetId: "end" };
    expect(evaluateGuard({ ...guard, variable: "missing" }, env, facts, endpoints)).toBe("unresolved");
    expect(evaluateGuard({ ...guard, variable: "y" }, env, facts, endpoints)).toBe("true");
    expect(evaluateGuard(guard, env, facts, endpoints)).toBe("true");
  });

  it.each(["relation", "and", "nested", "alternative", "sequence"] as const)(
    "preserves unresolved associated time through %s premises", (shape) => {
      const step = relation(timeGuard);
      const nested: QueryProgram = { schema_version: 1, kind: "hyperedge", join: "and", premises: [step] };
      const premise: QueryProgram = shape === "nested" ? nested
        : shape === "alternative" ? { schema_version: 1, kind: "alternative", options: [step] }
        : shape === "sequence" ? { schema_version: 1, kind: "sequence", steps: [step] } : step;
      const program: QueryProgram = shape === "relation" ? step
        : { schema_version: 1, kind: "hyperedge", join: "and", premises: [premise] };
      const query = compile(program);
      const seeds = seedActivationsForObservation(observation("seed"), query, INTERPRETATION_CLOCK);
      const rows = [{ sourceObjectId: "seed", targetObjectId: "end", predicate: "observed_log", assertionId: "edge",
        validity: { kind: "open" as const, valid_from: "2026-01-01T00:00:00Z" } }];
      const effects = (observed_at?: string) => adjacencyEffectsForRows(rows, {
        interpretation: query, asOf: INTERPRETATION_CLOCK, liveStates: seeds.map((seed) => seed.state), overlay: {},
        sourceFacts: new Map([["seed", { object_id: "seed", source_revision: "rev" }],
          ["end", { object_id: "end", source_revision: "rev", observed_at }]])
      });
      expect(effects().some((effect) => effect.unresolved_guard)).toBe(true);
      expect(effects().some((effect) => effect.transition || effect.hyperedge)).toBe(false);
      expect(effects("2026-09-09T00:00:00Z").some((effect) => effect.transition || effect.hyperedge)).toBe(true);
      expect(effects("2026-09-08T00:00:00Z").some((effect) => effect.unresolved_guard)).toBe(false);
    }
  );

  it.each(["relation", "nested"] as const)("preserves missing revision and transfer evidence in %s", (shape) => {
    const step = relation({ schema_version: 1, kind: "query_predicate", verdict: "unresolved", time_scope: "none" });
    const query = compile(shape === "relation" ? step : { schema_version: 1, kind: "hyperedge", join: "and",
      premises: [{ schema_version: 1, kind: "hyperedge", join: "and", premises: [step] }] });
    const seeds = seedActivationsForObservation(observation("seed"), query, INTERPRETATION_CLOCK);
    const effects = (assertionId: string, targetRevision?: string) => adjacencyEffectsForRows([
      { sourceObjectId: "seed", targetObjectId: "end", predicate: "observed_log", assertionId,
        validity: { kind: "open", valid_from: "2026-01-01T00:00:00Z" } }
    ], { interpretation: query, asOf: INTERPRETATION_CLOCK, overlay: {}, liveStates: seeds.map((seed) => seed.state),
      sourceFacts: new Map([["end", { object_id: "end", source_revision: targetRevision }]]) });
    expect(effects("edge").some((effect) => effect.missing_target_revision)).toBe(true);
    expect(effects("", "rev").some((effect) => effect.missing_measurement)).toBe(true);
    expect(effects("", "rev").some((effect) => effect.transition || effect.hyperedge)).toBe(false);
  });

  it.each(["A;y=B", "a=b;c%3B", "中文;角色=😀%", "\ud800;=", "long;=".repeat(100)])(
    "round-trips binding values without creating variables: %s", (value) => {
      const env = new Map([["x;=", value], ["y%3B", "tail"]]);
      const owner = new BindingContextStore(100_000);
      expect(parseBindingContext(encodeBindingContext(env, owner), owner)).toEqual(env);
      expect(encodeBindingContext(new Map([...env].reverse()), owner)).toBe(encodeBindingContext(env, owner));
      expect(encodeBindingContext(new Map([["x", "A;y=B"]])))
        .not.toBe(encodeBindingContext(new Map([["x", "A"], ["y", "B"]])));
    }
  );

  it("keeps long UTF-16 values distinct and rejects recovery outside the execution owner", () => {
    const owner = new BindingContextStore(10_000);
    const variable = "k".repeat(80);
    const values = ["\ud800", "\ufffd", "\ud801"].map((last) => "x".repeat(200) + last);
    const contexts = values.map((value) => encodeBindingContext(new Map([[variable, value]]), owner));
    expect(new Set(contexts).size).toBe(3);
    contexts.forEach((context, i) => expect(parseBindingContext(context, owner).get(variable)).toBe(values[i]));
    expect(() => parseBindingContext(contexts[0]!)).toThrow(BindingContextUnavailableError);
    expect(() => parseBindingContext(contexts[0]!, new BindingContextStore(10_000))).toThrow(BindingContextUnavailableError);
    expect(owner.bytes).toBeGreaterThan(3 * 2 * 280);
  });

  it("bounds full recovery storage and isolates a prepared fork", () => {
    const committed = new BindingContextStore(2_000);
    const original = encodeBindingContext(new Map([["x", "original".repeat(80)]]), committed);
    const before = committed.bytes;
    const prepared = committed.fork(2_000);
    const next = encodeBindingContext(new Map([["x", "prepared".repeat(80)]]), prepared);
    expect(committed.bytes).toBe(before);
    expect(() => parseBindingContext(next, committed)).toThrow(BindingContextUnavailableError);
    expect(parseBindingContext(original, prepared).get("x")).toBe("original".repeat(80));
    expect(() => encodeBindingContext(new Map([["x", "overflow".repeat(1000)]]), prepared)).toThrow(BindingContextResourceError);
    expect(prepared.bytes).toBeLessThanOrEqual(before + 2_000);
  });

  it.each(["relation", "hyperedge"] as const)("preserves a delimiter-bearing seed through %s admission", (kind) => {
    const step = relation({ schema_version: 1, kind: "query_predicate", verdict: "unresolved", time_scope: "none" });
    const query = compile(kind === "relation" ? step : { schema_version: 1, kind: "hyperedge", join: "and", premises: [step, step] });
    const source = "A;y=B";
    const seeds = seedActivationsForObservation(observation(source), query, INTERPRETATION_CLOCK);
    expect(seeds.length).toBeGreaterThan(0);
    expect(parseBindingContext(seeds[0]!.state.binding_context).get("x")).toBe(source);
    const effects = adjacencyEffectsForRows([{ sourceObjectId: source, targetObjectId: "C", predicate: "observed_log",
      assertionId: "assertion", validity: { kind: "open", valid_from: "2026-01-01T00:00:00Z" } }], {
      interpretation: query, asOf: INTERPRETATION_CLOCK, liveStates: seeds.map((seed) => seed.state),
      overlay: { observed_log: { milligrades: 1000, applicable: true } },
      sourceFacts: new Map([source, "C"].map((object_id) => [object_id, { object_id, source_revision: "rev" }]))
    });
    const targets = effects.flatMap((effect) => effect.transition ? [effect.transition.to] : effect.hyperedge ? [effect.hyperedge.to] : []);
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(parseBindingContext(target.binding_context)).toEqual(new Map([["x", source], ["y", "C"]]));
    }
  });

  it.each([
    ["2026-09-09T00:00:00.000Z", "true"],
    ["2026-09-09T00:00Z", "true"],
    ["2026-09-09T00:00:00.999999Z", "true"],
    ["2026-09-09T00:00:01.000000Z", "false"],
    ["2026-09-08T23:59:59.999999Z", "false"],
    ["not-an-instant", "unresolved"]
  ] as const)("agrees on half-open interval admission for %s", (stamp, expected) => {
    expect(evaluateGuard(timeGuard, new Map([["y", "C"]]), new Map([["C", { object_id: "C", observed_at: stamp }]]))).toBe(expected);
    const observed = buildTypedObservation(observerInput(timeGuard), { objectId: "C", sourceRevision: "rev",
      observationKey: "time", observedAt: stamp, identityKind: "assertion",
      sourceRow: { object_id: "C", sourceRevision: "rev", observed_at: stamp },
      relation: { assertionId: "edge", sourceObjectId: "seed", targetObjectId: "C", resultObjectId: "C", predicate: "observed_log" } });
    expect(observed?.applicability.verdict ?? "false").toBe(expected);
  });

  it("preserves submillisecond interval boundaries", () => {
    const guard = { ...timeGuard, interval: { ...interval, start: "2026-09-09T00:00:00.0001Z", end: "2026-09-09T00:00:00.0002Z" } };
    for (const [stamp, expected] of [["2026-09-09T00:00:00.0001000Z", "true"], ["2026-09-09T00:00:00.000200Z", "false"]] as const) {
      expect(evaluateGuard(guard, new Map([["y", "C"]]), new Map([["C", { object_id: "C", observed_at: stamp }]]))).toBe(expected);
    }
  });

  it("uses instant order for source lifecycle and resolved relations", () => {
    const input = { ...observerInput(timeGuard), as_of: interval.start };
    expect(sourceRowEligible(input, { object_id: "C", sourceRevision: "rev", valid_from: "2026-09-09T00:00:00.000Z" })).toBe(true);
    expect(sourceRowEligible(input, { object_id: "C", sourceRevision: "rev", valid_to: "2026-09-09T00:00:00.000Z" })).toBe(false);
    expect(sourceRowEligible(input, { object_id: "C", sourceRevision: "rev", valid_from: "2026-09-09T00:00:00.0001Z" })).toBe(false);
    const row = { assertionId: "edge", sourceObjectId: "seed", targetObjectId: "C", resultObjectId: "C", predicate: "observed_log",
      validity: { kind: "open" as const, valid_from: "2026-01-01T00:00:00Z" }, resolutionKind: "retracted" as const };
    expect(relationRowEligible(input, { ...row, resolvedAt: "2026-09-09T00:00:00.000Z" })).toBe(false);
    expect(relationRowEligible(input, { ...row, resolvedAt: "2026-09-09T00:00:00.0001Z" })).toBe(true);
    const future = { assertionId: "edge", sourceObjectId: "seed", targetObjectId: "C", resultObjectId: "C", predicate: "observed_log",
      validity: { kind: "open" as const, valid_from: "2026-09-09T00:00:00.0001Z" } };
    expect(relationRowEligible(input, future)).toBe(false);
    expect(relationRowEligible({ ...input, as_of: "2026-09-09T00:00:00.000100Z" }, future)).toBe(true);
  });
});
