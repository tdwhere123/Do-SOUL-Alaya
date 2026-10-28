import { describe, expect, it } from "vitest";
import { MemoryDimension, productSubjectId, type Guard, type QueryInterpretation, type QueryProgram } from "@do-soul/alaya-protocol";
import { PersistentStringMap } from "@do-soul/alaya-graph-algorithms";
import { observeField } from "../../../../recall/runtime/conditional-field-observe.js";
import { assessUnknownCause } from "../../../../recall/runtime/semantic-attribution.js";
import type { FieldEngineState } from "../../../../recall/conditional-field/engine/field-engine.js";
import type { SourceObserverPage } from "../../../../recall/conditional-field/observers/observe.js";
import { encodeSourceFilters } from "../../../../recall/conditional-field/query/ordinary-language.js";
import { RequestCostLedger } from "../../../../recall/runtime/request-cost-ledger.js";
import { meterReaders } from "../../../../recall/runtime/observer-reader-budget.js";
import { defaultBudget, defaultView, SNAPSHOT_ID } from "../reference/deployment.fixture.js";

const AS_OF = "2026-09-07T00:00:00.000Z";
const TRUE_GUARD = { schema_version: 1, kind: "query_predicate", time_scope: "none", verdict: "unresolved" } as const;

function relation(kind: string, source: string, target: string, guard: Guard = TRUE_GUARD): QueryProgram {
  return { schema_version: 1, kind: "relation", relation_kind: kind,
    source_variable: source, target_variable: target, guard, facet_mode: "same_path", threshold_milligrades: 0 };
}

function query(program: QueryProgram, patch: Partial<QueryInterpretation> = {}): QueryInterpretation {
  return { schema_version: 1, query_id: "consumer-observation", snapshot_id: SNAPSHOT_ID,
    status: "resolved", holes: [], hypotheses: [], view: defaultView(), program, ...patch };
}

function edge(source: string, target: string, predicate: string, id = `${source}-${target}-${predicate}`) {
  return { assertionId: id, sourceObjectId: source, targetObjectId: target, resultObjectId: target,
    predicate, source_revision: "rev", validity: { kind: "open" as const, valid_from: "2026-01-01T00:00:00.000Z" },
    sourceObservations: [{ source_id: `event-${id}`, source_sha256: "rev" }],
    evidenceReceipts: [{ evidenceId: `evidence-${id}`, eventId: `event-${id}`, eventType: "test", occurredAt: AS_OF }] };
}

function fixture(program: QueryProgram, rows: readonly ReturnType<typeof edge>[], options: Readonly<{
  sourceRows?: Readonly<Record<string, Readonly<{ scope_class?: string; predicates?: Readonly<Record<string, boolean>> }> | null>>;
  interpretation?: Partial<QueryInterpretation>;
  resume?: FieldEngineState;
  scopes?: readonly string[] | null;
  work?: number;
  memory?: number;
  reserve?: number;
  lexicalIds?: readonly string[];
  sourceReader?: (objectId: string) => SourceObserverPage;
  snapshotPin?: () => Readonly<{ source_revision: string }>;
  expectedRevision?: string;
  cost?: RequestCostLedger;
}> = {}) {
  const relationCalls: string[] = [];
  const sourceCalls: string[] = [];
  const sourceRows = options.sourceRows ?? {};
  const state = observeField(query(program, options.interpretation), {
    workspace_id: "ws", query_text: "a", as_of: AS_OF, authorized_scopes: options.scopes ?? null,
    ...(options.resume === undefined ? {} : { resume_field: options.resume }),
    ...(options.expectedRevision === undefined ? {} : { expected_source_revision: options.expectedRevision }),
    ...(options.cost === undefined ? {} : { cost: options.cost }),
    budget: defaultBudget({ work_units: options.work ?? 10_000, memory_bytes: options.memory ?? 1_000_000,
      ...(options.reserve === undefined ? {} : { finalization_reserve: options.reserve }) }),
    readers: {
      lexical: () => ({ ids: options.lexicalIds ?? ["a"], nativeVisits: 1, nativeBytes: 1,
        rowsRead: (options.lexicalIds ?? ["a"]).length, bytesRead: 1, truncated: false }),
      ...(options.snapshotPin === undefined ? {} : { snapshotPin: options.snapshotPin }),
      source: ({ objectId }) => {
        sourceCalls.push(objectId);
        if (options.sourceReader !== undefined) return options.sourceReader(objectId);
        const specified = sourceRows[objectId];
        if (specified === null) return { row: null, rowsRead: 0, bytesRead: 0, unavailable: true };
        return { row: { object_id: objectId, sourceRevision: "rev", lifecycle_state: "active",
          scope_class: specified?.scope_class ?? "project",
          ...(specified?.predicates === undefined ? {} : { predicates: specified.predicates }) },
          rowsRead: 1, bytesRead: 32, unavailable: false };
      },
      relation: ({ subject, predicate, afterAssertionId, limit, nativeLimit }) => {
        relationCalls.push(`${subject ?? "null"}\0${predicate}`);
        const remaining = rows.filter((row) => row.sourceObjectId === subject && row.predicate === predicate
          && row.assertionId > (afterAssertionId ?? "")).sort((left, right) => left.assertionId.localeCompare(right.assertionId));
        const observations = remaining.slice(0, Math.min(limit, nativeLimit));
        return { observations, nativeVisits: observations.length, nativeBytes: observations.length * 32,
          rowsRead: observations.length, bytesRead: observations.length * 32, truncated: observations.length < remaining.length,
          committedThrough: observations.at(-1)?.assertionId ?? afterAssertionId };
      }
    }
  });
  const accepted = state.binding.kind === "bound" ? state.binding.snapshot.values
    .filter((value) => value.accepting && (value.milligrades ?? 0) > 0)
    .map((value) => productSubjectId(value.state)) : [];
  return { state, accepted, relationCalls, sourceCalls };
}

describe("consumer-directed physical observation", () => {
  it("refuses an over-budget source receipt before caching it", () => {
    const cache = new Map<string, SourceObserverPage>();
    const cost = new RequestCostLedger();
    const readers = meterReaders({ source: () => ({ row: null, rowsRead: 5, bytesRead: 1, unavailable: true }) },
      { remaining: 64, cachedBytes: 0 }, cache, work => cost.add("observe", work));
    expect(() => readers.source!({ workspaceId: "ws", objectId: "x" })).toThrowError(expect.objectContaining({
      code: "OBLIGATION_VIOLATION", message: "source reader exceeded its singleton hydration reserve"
    }));
    expect(cache.size).toBe(0);
    expect(cost.snapshot().phases.observe).toMatchObject({ native_visits: 5, native_bytes: 1 });
  });

  it("keeps the preceding lexical visit when source receipt validation fails", () => {
    const cost = new RequestCostLedger();
    expect(() => fixture(relation("p", "s", "t"), [], { cost, sourceReader: () => ({
      row: null, rowsRead: 5, bytesRead: 7, unavailable: true
    }) })).toThrowError(expect.objectContaining({ code: "OBLIGATION_VIOLATION" }));
    expect(cost.snapshot().native_visits).toBe(6);
    expect(cost.snapshot().native_bytes).toBe(8);
  });

  it.each([
    { rowsRead: -1, bytesRead: 7, visits: null, bytes: 7 },
    { rowsRead: Number.NaN, bytesRead: 7, visits: null, bytes: 7 },
    { rowsRead: 4, bytesRead: Number.NaN, visits: 4, bytes: null }
  ])("preserves unknown source receipt counters without admitting %j", row => {
    const cache = new Map<string, SourceObserverPage>();
    const readers = meterReaders({ source: () => ({ row: null, rowsRead: row.rowsRead,
      bytesRead: row.bytesRead, unavailable: true }) }, { remaining: 64, cachedBytes: 0 }, cache);
    let failure: unknown;
    try { readers.source!({ workspaceId: "ws", objectId: "x" }); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "OBLIGATION_VIOLATION",
      details: { source_read: { native_visits: row.visits, native_bytes: row.bytes } } });
    expect(cache.size).toBe(0);
  });

  it("keeps a memory refusal and a limited source page out of the completed source cache", () => {
    let calls = 0;
    const memory = { remaining: 0, cachedBytes: 0 };
    const cache = new Map();
    const readers = meterReaders({ source: () => {
      calls += 1;
      return calls === 1 ? { row: null, rowsRead: 0, bytesRead: 0, unavailable: false, resourceLimited: true }
        : { row: null, rowsRead: 0, bytesRead: 0, unavailable: true };
    } }, memory, cache);
    const key = { workspaceId: "ws", objectId: "x" };
    expect(readers.source!(key)).toMatchObject({ resourceLimited: true, unavailable: false });
    expect(calls).toBe(0);
    memory.remaining = 32;
    expect(readers.source!(key).resourceLimited).toBe(true);
    expect(calls).toBe(1);
    expect(readers.source!(key).unavailable).toBe(true);
    expect(readers.source!(key).resourceLimited).toBeUndefined();
    expect(readers.source!(key).unavailable).toBe(true);
    expect(calls).toBe(2);
  });

  it("settles an actually unavailable bound source without retrying it", () => {
    const guard: Guard = { schema_version: 1, kind: "authorization", variable: "c",
      authorization_scope: "project", time_scope: "none", verdict: "unresolved" };
    const interpretation = { hypotheses: [{ schema_version: 1 as const, hypothesis_id: "h",
      bindings: [{ schema_version: 1 as const, variable: "c", value: "x" }] }] };
    const program = relation("p", "s", "t", guard);
    const first = fixture(program, [edge("a", "b", "p")], { interpretation, sourceRows: { x: null } });
    expect(first.sourceCalls).toContain("x");
    expect(first.state.source_fact_demands.get("x")).toBe("done");
    const continued = fixture(program, [edge("a", "b", "p")], {
      interpretation, sourceRows: { x: null }, resume: first.state });
    expect(continued.sourceCalls).not.toContain("x");
    expect(continued.state.source_fact_demands.get("x")).toBe("done");
  });

  it("reads claim evidence for an accepting epsilon product", () => {
    const view = { ...defaultView(), claim_demands: [{ variable: "h", proposition_kind: "cause",
      argument_variables: ["c", "h"], required_claim: "supported" as const }] };
    const result = fixture({ schema_version: 1, kind: "epsilon" }, [edge("a", "a", "cause")], {
      interpretation: { view, hypotheses: [{ schema_version: 1, hypothesis_id: "h",
        bindings: [{ schema_version: 1, variable: "c", value: "a" },
          { schema_version: 1, variable: "h", value: "a" }] }] }
    });
    expect(result.relationCalls).toContain("a\0cause");
    expect([...assessUnknownCause(result.state, { as_of: AS_OF }).claims.values()]).toContain("supported");
  });

  it("demands the literal relation kind even when aliases also apply", () => {
    const result = fixture(relation("failed_deployment", "s", "t"),
      [edge("a", "b", "failed_deployment")]);
    expect(result.relationCalls).toContain("a\0failed_deployment");
    expect(result.accepted).toContain("b");
  });

  it("hydrates a bound source for an equality guard's attached filter", () => {
    const guard: Guard = { schema_version: 1, kind: "equality", variable: "c", equals_variable: "d",
      predicate_name: encodeSourceFilters({ dimension_filter: [MemoryDimension.FACT] }),
      time_scope: "none", verdict: "unresolved" };
    const result = fixture(relation("p", "s", "t", guard), [edge("a", "b", "p")], {
      interpretation: { hypotheses: [{ schema_version: 1, hypothesis_id: "h",
        bindings: [{ schema_version: 1, variable: "c", value: "x" },
          { schema_version: 1, variable: "d", value: "x" }] }] },
      sourceReader: (objectId) => ({ row: { object_id: objectId, sourceRevision: "rev",
        lifecycle_state: "active", scope_class: "project", dimension: MemoryDimension.FACT },
        rowsRead: 1, bytesRead: 32, unavailable: false })
    });
    expect(result.sourceCalls).toContain("x");
    expect(result.accepted).toContain("b");
  });

  it("hydrates a bound source for a source-bound-entity guard's attached filter", () => {
    const guard: Guard = { schema_version: 1, kind: "source_bound_entity", variable: "c", entity_id: "x",
      predicate_name: encodeSourceFilters({ dimension_filter: [MemoryDimension.FACT] }),
      time_scope: "none", verdict: "unresolved" };
    const result = fixture(relation("p", "s", "t", guard), [edge("a", "b", "p")], {
      interpretation: { hypotheses: [{ schema_version: 1, hypothesis_id: "h",
        bindings: [{ schema_version: 1, variable: "c", value: "x" }] }] },
      sourceReader: (objectId) => ({ row: { object_id: objectId, sourceRevision: "rev",
        lifecycle_state: "active", scope_class: "project", dimension: MemoryDimension.FACT },
        rowsRead: 1, bytesRead: 32, unavailable: false })
    });
    expect(result.sourceCalls).toContain("x");
    expect(result.accepted).toContain("b");
  });

  it("keeps a resource-limited source fact pending until a later lawful read", () => {
    const guard: Guard = { schema_version: 1, kind: "authorization", variable: "c",
      authorization_scope: "project", time_scope: "none", verdict: "unresolved" };
    const interpretation: Partial<QueryInterpretation> = { hypotheses: [{ schema_version: 1, hypothesis_id: "h",
      bindings: [{ schema_version: 1, variable: "c", value: "x" }] }] };
    const first = fixture(relation("p", "s", "t", guard), [edge("a", "b", "p")], {
      interpretation, sourceReader: (objectId) => objectId === "x"
        ? { row: null, rowsRead: 0, bytesRead: 0, unavailable: false, resourceLimited: true }
        : { row: { object_id: objectId, sourceRevision: "rev", lifecycle_state: "active",
          scope_class: "project" }, rowsRead: 1, bytesRead: 32, unavailable: false }
    });
    expect(first.state.source_fact_demands.get("x")).toBe("pending");
    expect(first.state.last_observer_status).toBe("interrupted");
    const next = fixture(relation("p", "s", "t", guard), [edge("a", "b", "p")], {
      interpretation, resume: first.state, memory: 2_000_000
    });
    expect(next.sourceCalls).toContain("x");
    expect(next.accepted).toContain("b");
    expect(next.state.source_fact_demands.get("x")).toBe("done");
  });

  it("replays an old guarded row after later seed hydration and clears its obsolete unknown", () => {
    const guard: Guard = { schema_version: 1, kind: "authorization", variable: "c",
      authorization_scope: "project", time_scope: "none", verdict: "unresolved" };
    const interpretation: Partial<QueryInterpretation> = { hypotheses: [{ schema_version: 1, hypothesis_id: "h",
      bindings: [{ schema_version: 1, variable: "c", value: "x" }] }] };
    const first = fixture(relation("p", "s", "t", guard), [edge("a", "b", "p")], {
      interpretation, sourceRows: { x: null }
    });
    expect(first.accepted).not.toContain("b");
    const resumed = { ...first.state, residuals: first.state.residuals.map((row) =>
      row.kind === "seed" ? { ...row, status: "open" as const } : row),
      resume_cursors: { ...first.state.resume_cursors, seed: null } };
    const next = fixture(relation("p", "s", "t", guard), [edge("a", "b", "p")], {
      interpretation, resume: resumed, lexicalIds: ["x"]
    });
    expect(next.state.source_facts?.has("x")).toBe(true);
    expect(next.accepted).toContain("b");
    expect(next.state.residuals.find((row) => row.kind === "guard")?.status).toBe("exhausted");
  });

  it("reserves lookup, singleton hydration and completion before reading a pending fact", () => {
    const first = fixture(relation("p", "s", "t"), [edge("a", "b", "p")]);
    const pending = { ...first.state,
      source_fact_demands: new PersistentStringMap<"pending" | "done">().with("x", "pending"),
      source_fact_pending_count: 1, source_fact_scan_offset: 0, source_fact_demand_bytes: 97 };
    const sourceReader = (objectId: string) => ({ row: { object_id: objectId, sourceRevision: "rev",
      lifecycle_state: "active", scope_class: "project" }, rowsRead: 4, bytesRead: 32, unavailable: false });
    const short = fixture(relation("p", "s", "t"), [], { resume: pending, work: 6, reserve: 0, sourceReader });
    expect(short.sourceCalls).not.toContain("x");
    expect(short.state.source_fact_demands.get("x")).toBe("pending");
    const enough = fixture(relation("p", "s", "t"), [], { resume: pending, work: 7, reserve: 0, sourceReader });
    expect(enough.sourceCalls).toContain("x");
    expect(enough.state.source_fact_demands.get("x")).toBe("done");
    expect(enough.state.remaining_exploration).toBe(0);
    const cost = new RequestCostLedger();
    fixture(relation("p", "s", "t"), [], { resume: pending, work: 7, reserve: 0, cost,
      sourceReader: objectId => ({ ...sourceReader(objectId), rowsRead: 0, bytesRead: 0 }) });
    expect(cost.snapshot().phases.observe).toMatchObject({ native_visits: 0, native_rows: 0 });
  });

  it("charges a changed source pin even when it invalidates a pending fact read", () => {
    const program = relation("p", "s", "t");
    const first = fixture(program, [edge("a", "b", "p")], { expectedRevision: "rev" });
    const pending = { ...first.state, source_fact_demands:
      new PersistentStringMap<"pending" | "done">().with("x", "pending"),
      source_fact_pending_count: 1, source_fact_scan_offset: 0, source_fact_demand_bytes: 97 };
    let pins = 0;
    const cost = new RequestCostLedger();
    const next = fixture(program, [], { resume: pending, work: 10, reserve: 0, expectedRevision: "rev", cost,
      snapshotPin: () => { pins += 1; return { source_revision: "changed" }; } });
    expect(pins).toBe(1);
    expect(next.sourceCalls).not.toContain("x");
    expect(next.state.last_observer_status).toBe("invalidated");
    expect(cost.snapshot().phases.observe.native_visits).toBeGreaterThanOrEqual(1);
    expect(next.state.remaining_exploration).toBe(6);
  });

  it("meters mixed completed and pending fact demands across small continuations", () => {
    const program = relation("p", "s", "t");
    const first = fixture(program, [edge("a", "b", "p")]);
    let map = new PersistentStringMap<"pending" | "done">();
    for (let index = 0; index < 64; index += 1) map = map.with(`done-${String(index).padStart(2, "0")}`, "done");
    map = map.with("zz-x", "pending");
    let indexed = 0;
    const counting = new Proxy(map, { get(target, property) {
      if (property === "entryAt") return (index: number) => { indexed += 1; return target.entryAt(index); };
      if (property === Symbol.iterator || property === "values") {
        return () => { throw new Error("full-map traversal is not admitted"); };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    let state: FieldEngineState = { ...first.state, source_fact_demands: counting,
      source_fact_pending_count: 1, source_fact_scan_offset: 0, source_fact_demand_bytes: 7_000 };
    let reads = 0;
    for (let turn = 0; turn < 8 && state.source_fact_pending_count > 0; turn += 1) {
      const before = indexed;
      const next = fixture(program, [], { resume: state, work: 16, reserve: 0 });
      reads += next.sourceCalls.filter((id) => id === "zz-x").length;
      expect(indexed - before).toBeLessThanOrEqual(16);
      expect(16 - next.state.remaining_exploration).toBeGreaterThanOrEqual(indexed - before);
      state = next.state;
    }
    expect(indexed).toBeGreaterThanOrEqual(65);
    expect(reads).toBe(1);
    expect(state.source_fact_pending_count).toBe(0);
    expect(state.source_fact_demands.get("zz-x")).toBe("done");
    const beforeSettled = indexed;
    fixture(program, [], { resume: state, work: 16, reserve: 0 });
    expect(indexed).toBe(beforeSettled);
  });

  it.each([1, 9])("retains pair-scan progress with %s seed hypotheses while reserving the next adjacency row", count => {
    const program = relation("p", "s", "t");
    const interpretation = { hypotheses: Array.from({ length: count }, (_, index) => ({
      schema_version: 1 as const, hypothesis_id: `hypothesis-${index}`, bindings: []
    })) };
    const first = fixture(program, [edge("a", "b", "p")], { interpretation });
    let demands = new PersistentStringMap<true>();
    let progress = new PersistentStringMap<string | null>();
    for (let index = 0; index < 4; index += 1) {
      const key = `done-${index}\0p`;
      demands = demands.with(key, true);
      progress = progress.with(`${key}:done`, "1");
    }
    demands = demands.with("zz\0p", true);
    let state: FieldEngineState = { ...first.state, pair_demands: demands, pair_progress: progress,
      pair_completed_count: 4, pair_revision: 4, pair_scan_offset: 0 };
    const calls: string[] = [];
    for (let turn = 0; turn < 5; turn += 1) {
      const next = fixture(program, [], { resume: state, work: 16, reserve: 0, interpretation });
      calls.push(...next.relationCalls);
      expect(next.state.remaining_exploration).toBeGreaterThanOrEqual(0);
      if (turn < 4) expect(next.state.pair_scan_offset).toBe(turn + 1);
      state = next.state;
    }
    expect(calls).toEqual(["zz\0p"]);
    expect(state.pair_progress.get("zz\0p:done")).toBe("1");
  });

  it("closes a single relation kind with local empty reads", () => {
    const result = fixture(relation("p", "s", "t"), [edge("a", "b", "p")]);
    expect(result.accepted).toContain("b");
    expect(result.relationCalls).toContain("a\0p");
    expect(result.relationCalls).not.toContain("b\0p");
    expect(result.state.residuals.find((row) => row.kind === "adjacency")?.status).toBe("exhausted");
  });

  it("does not reuse physical completion across a changed program or scope", () => {
    const rows = [edge("a", "b", "p"), edge("a", "c", "q")];
    const first = fixture(relation("p", "s", "t"), rows);
    expect(first.accepted).toContain("b");
    const changedProgram = fixture(relation("q", "s", "t"), rows, { resume: first.state });
    expect(changedProgram.relationCalls).toContain("a\0q");
    expect(changedProgram.accepted).toContain("c");
    expect(changedProgram.accepted).not.toContain("b");
    const changedScope = fixture(relation("p", "s", "t"), rows, { resume: first.state, scopes: [] });
    expect(changedScope.accepted).not.toContain("b");
    expect(changedScope.state.pair_progress).not.toBe(first.state.pair_progress);
  });

  it("reads an internal node of a nested hyperedge premise", () => {
    const nested: QueryProgram = { schema_version: 1, kind: "hyperedge", join: "or", premises: [
      { schema_version: 1, kind: "sequence", steps: [relation("p", "s", "m"), relation("q", "m", "t")] },
      relation("r", "s", "t")
    ] };
    const result = fixture(nested, [edge("a", "middle", "p"), edge("middle", "end", "q")]);
    expect(result.relationCalls).toContain("middle\0q");
    expect(result.accepted).toContain("end");
  });

  it("reads a third bound source before resolving its authorization guard", () => {
    const guard = { schema_version: 1, kind: "authorization", authorization_scope: "project",
      variable: "c", time_scope: "none", verdict: "unresolved" } as const;
    const interpretation: Partial<QueryInterpretation> = { hypotheses: [{ schema_version: 1,
      hypothesis_id: "h", bindings: [{ schema_version: 1, variable: "c", value: "x" }] }] };
    const result = fixture(relation("p", "s", "t", guard), [edge("a", "b", "p")], { interpretation });
    expect(result.sourceCalls).toContain("x");
    expect(result.accepted).toContain("b");
    expect(result.state.residuals.find((row) => row.kind === "guard")?.status).toBe("exhausted");
    const absent = fixture(relation("p", "s", "t", guard), [edge("a", "b", "p")], {
      interpretation, sourceRows: { x: null }
    });
    expect(absent.accepted).not.toContain("b");
    expect(absent.sourceCalls.filter((id) => id === "x")).toHaveLength(1);
    expect(absent.state.residuals.find((row) => row.kind === "guard")?.status).toBe("unknown");
  });

  it("keeps an actual unknown guard independent of a positive branch", () => {
    const unknown = { schema_version: 1, kind: "query_predicate", predicate_name: "unavailable_flag",
      variable: "t", time_scope: "none", verdict: "true" } as const;
    const program: QueryProgram = { schema_version: 1, kind: "alternative", options: [
      relation("p", "s", "t", unknown), relation("q", "s", "u")
    ] };
    const result = fixture(program, [edge("a", "blocked", "p"), edge("a", "allowed", "q")]);
    expect(result.accepted).toContain("allowed");
    expect(result.accepted).not.toContain("blocked");
    expect(result.state.residuals.find((row) => row.kind === "guard")?.status).toBe("unknown");
  });

  it("replaces a hydrated guard verdict while retaining another branch's unknown", () => {
    const authorization: Guard = { schema_version: 1, kind: "authorization", authorization_scope: "project",
      variable: "c", time_scope: "none", verdict: "unresolved" };
    const unknown: Guard = { schema_version: 1, kind: "query_predicate", predicate_name: "unavailable_flag",
      variable: "t", time_scope: "none", verdict: "true" };
    const program: QueryProgram = { schema_version: 1, kind: "alternative", options: [
      relation("p", "s", "t", authorization), relation("q", "s", "t", unknown),
      relation("r", "s", "t")
    ] };
    const interpretation: Partial<QueryInterpretation> = { hypotheses: [{ schema_version: 1,
      hypothesis_id: "h", bindings: [{ schema_version: 1, variable: "c", value: "x" }] }] };
    const rows = [edge("a", "authorized", "p"), edge("a", "unknown", "q"), edge("a", "independent", "r")];
    const trueFact = fixture(program, rows, { interpretation, sourceRows: { x: { scope_class: "project" } } });
    expect(trueFact.sourceCalls).toContain("x");
    expect(trueFact.accepted).toEqual(expect.arrayContaining(["authorized", "independent"]));
    expect(trueFact.accepted).not.toContain("unknown");
    expect(trueFact.state.residuals.find((row) => row.kind === "guard")?.status).toBe("unknown");
    const falseFact = fixture(program, rows, { interpretation, sourceRows: { x: { scope_class: "private" } } });
    expect(falseFact.accepted).not.toContain("authorized");
    expect(falseFact.accepted).toContain("independent");
    expect(falseFact.state.residuals.find((row) => row.kind === "guard")?.status).toBe("unknown");
  });

  it("reads claim evidence from a bound cause outside relation endpoints", () => {
    const view = { ...defaultView(), claim_demands: [{ variable: "h", proposition_kind: "cause",
      argument_variables: ["c", "h"], required_claim: "supported" as const }] };
    const result = fixture(relation("p", "s", "h"), [edge("a", "b", "p"), edge("x", "b", "cause")], {
      interpretation: { hypotheses: [{ schema_version: 1, hypothesis_id: "h",
        bindings: [{ schema_version: 1, variable: "c", value: "x" }] }], view }
    });
    expect(result.relationCalls).toContain("x\0cause");
    expect([...result.state.observed_relations ?? []].some((row) => row.sourceObjectId === "x" && row.predicate === "cause")).toBe(true);
    const assessed = assessUnknownCause(result.state, { as_of: AS_OF });
    expect([...assessed.claims.values()]).toContain("supported");
  });

  it("rejects nested repeat expansion before any native read under a tight envelope", () => {
    let program: QueryProgram = relation("p", "s", "t");
    for (let index = 0; index < 4; index += 1) program = { schema_version: 1, kind: "repeat",
      count: 8, local_variables: ["s", "t"], body: program };
    const result = fixture(program, [], { work: 200, memory: 10_000 });
    expect(result.relationCalls).toEqual([]);
    expect(result.state.last_observer_status).toBe("interrupted");
    expect(result.state.memory_exhausted).toBe(true);
  });
});
