import { afterEach, describe, expect, it } from "vitest";
import {
  MemoryDimension,
  productSubjectId,
  type QueryInterpretation,
  type QueryProgram,
  type RelationValidity
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import { createConditionalFieldObserverReaders } from "../../../../../../../apps/core-daemon/src/runtime/recall-read-worker/observer-operations.js";
import { observeField, type ObserveFieldInput } from "../../../../recall/runtime/conditional-field-observe.js";
import { RequestCostLedger } from "../../../../recall/runtime/request-cost-ledger.js";
import type { FieldEngineState } from "../../../../recall/conditional-field/engine/field-engine.js";
import type { ObserverReaders } from "../../../../recall/conditional-field/observers/observe.js";
import { defaultBudget, defaultView, SNAPSHOT_ID } from "../reference/deployment.fixture.js";
import { MEM, openSourceSlice, WS } from "../vertical/source-slice.js";

const AS_OF = "2026-09-07T00:00:00.000Z";
const VALIDITY: RelationValidity = { kind: "open", valid_from: "2026-01-01T00:00:00.000Z" };
const databases = new Set<StorageDatabase>();
afterEach(() => { for (const database of databases) database.close(); databases.clear(); });

type ReadTrace = Readonly<{ subject: string | null; predicate: string; rows: number; bytes: number }>;

describe("state-guided typed relation observation", () => {
  it.each(["a", "b"] as const)("requests the bound middle for seed %s before unrelated pairs", (variant) => {
    const edges = variant === "a"
      ? [edge("seed-a", "middle-a", "observed_log", "a1"), edge("middle-a", "end-a", "config_direct", "a2")]
      : [edge("seed-b", "middle-b", "observed_log", "b1"), edge("middle-b", "end-b", "config_direct", "b2")];
    const scan = run(mockReaders(edges), undefined);
    const guided = run(mockReaders(edges), "state_guided");
    const middle = `middle-${variant}`;
    const firstConfig = guided.trace.find((row) => row.predicate === "config_direct");
    expect(firstConfig?.subject).toBe(middle);
    if (variant === "b") {
      expect(scan.trace.find((row) => row.predicate === "config_direct")?.subject).not.toBe(middle);
    }
    expect(accepting(guided.state)).toEqual([`end-${variant}`]);
    expect(semantic(guided.state)).toEqual(semantic(scan.state));
    expect(guided.trace.some((row) => row.rows === 0)).toBe(true);
    expect(guided.cost.phases.adjacency.joins).toBeGreaterThan(scan.cost.phases.adjacency.joins);
    report(`mock-${variant}`, scan, guided);
  });

  it("keeps both independent paths and an unresolved alternative through same-execution continuation", () => {
    const edges = [
      edge("seed-a", "middle-a", "observed_log", "a1"),
      edge("middle-a", "end-a", "config_direct", "a2"),
      edge("seed-b", "middle-b", "observed_log", "b1"),
      edge("middle-b", "end-b", "config_direct", "b2"),
      edge("seed-b", "other", "service_history", "b3")
    ];
    const scanFirst = run(mockReaders(edges), undefined, 500, 1);
    const guidedFirst = run(mockReaders(edges), "state_guided", 500, 1);
    expect(scanFirst.state.budget).toEqual(guidedFirst.state.budget);
    expect(scanFirst.turns).toBe(1);
    expect(guidedFirst.turns).toBe(1);
    report("constrained-first-page", scanFirst, guidedFirst);
    const scan = run(mockReaders(edges), undefined, 500);
    const guided = run(mockReaders(edges), "state_guided", 500);
    expect(accepting(guided.state)).toEqual(["end-a", "end-b", "other"]);
    expect(semantic(guided.state)).toEqual(semantic(scan.state));
    expect(guided.turns).toBeGreaterThan(1);
    expect(guided.trace.some((row) => row.rows === 0)).toBe(true);
    report("continued-alternatives", scan, guided);
  });

  it.each(["a", "b"] as const)("changes actual SQLite relation requests for binding %s", async (variant) => {
    const slice = await openSourceSlice((database) => databases.add(database));
    const ids = [MEM.r, MEM.s, MEM.l, MEM.h, MEM.c, MEM.p];
    for (const [index, id] of ids.entries()) await slice.writeMemory(id, `observation node ${index}`, MemoryDimension.FACT);
    const links: readonly (readonly [string, string, string])[] = variant === "a"
      ? [[MEM.r, MEM.l, "observed_log"], [MEM.l, MEM.c, "config_direct"]]
      : [[MEM.s, MEM.h, "observed_log"], [MEM.h, MEM.p, "config_direct"]];
    for (const [index, [sourceId, targetId, relationKind]] of links.entries()) {
      await slice.admitRelation({ evidenceId: `bbbbbbbb-bbbb-4bbb-8bbb-0000000003${String(index).padStart(2, "0")}`,
        assertionId: `state-observation-${index}`, sourceId, targetId, resultObjectId: targetId,
        relationKind, validity: VALIDITY, gist: `relation ${index}` });
    }
    const native = createConditionalFieldObserverReaders(slice.database);
    const makeReaders = (): ObserverReaders => ({
      lexical: () => ({ ids: [MEM.r, MEM.s], nativeVisits: 2, nativeBytes: 2, rowsRead: 2, bytesRead: 2, truncated: false }),
      source: native.source,
      relation: native.relation
    });
    const scan = run(makeReaders(), undefined);
    const guided = run(makeReaders(), "state_guided");
    const middle = variant === "a" ? MEM.l : MEM.h;
    expect(guided.trace.find((row) => row.predicate === "config_direct")?.subject).toBe(middle);
    expect(accepting(guided.state)).toEqual([variant === "a" ? MEM.c : MEM.p]);
    expect(semantic(guided.state)).toEqual(semantic(scan.state));
    expect(guided.trace.some((row) => row.rows === 0)).toBe(true);
    report(`sqlite-${variant}`, scan, guided);
  });
});

function relation(kind: string, source: string, target: string): QueryProgram {
  return { schema_version: 1, kind: "relation", relation_kind: kind, source_variable: source,
    target_variable: target, facet_mode: "same_path", threshold_milligrades: 0,
    guard: { schema_version: 1, kind: "query_predicate", verdict: "unresolved", time_scope: "none" } };
}

function interpretation(): QueryInterpretation {
  return { schema_version: 1, query_id: "state-guided-typed-observation", snapshot_id: SNAPSHOT_ID,
    status: "resolved", holes: [], hypotheses: [], view: defaultView(),
    program: { schema_version: 1, kind: "alternative", options: [
      { schema_version: 1, kind: "sequence", steps: [
        relation("observed_log", "s", "m"), relation("config_direct", "m", "e")
      ] }, relation("service_history", "s", "e")
    ] } };
}

function edge(sourceObjectId: string, targetObjectId: string, predicate: string, assertionId: string) {
  return { sourceObjectId, targetObjectId, resultObjectId: targetObjectId, predicate, assertionId,
    validity: VALIDITY, evidenceRefs: [assertionId] };
}

function mockReaders(edges: readonly ReturnType<typeof edge>[]): ObserverReaders {
  return {
    lexical: () => ({ ids: ["seed-a", "seed-b"], nativeVisits: 2, nativeBytes: 2,
      rowsRead: 2, bytesRead: 2, truncated: false }),
    source: ({ objectId }) => ({ row: { object_id: objectId, sourceRevision: "rev",
      lifecycle_state: "active", scope_class: "project" }, rowsRead: 1, bytesRead: 1, unavailable: false }),
    relation: ({ subject, predicate, afterAssertionId }) => {
      const rows = edges.filter((row) => row.sourceObjectId === subject && row.predicate === predicate
        && (afterAssertionId === null || row.assertionId > afterAssertionId));
      return { observations: rows, nativeVisits: rows.length, nativeBytes: rows.length,
        rowsRead: rows.length, bytesRead: rows.length, truncated: false,
        committedThrough: rows.at(-1)?.assertionId ?? afterAssertionId };
    }
  };
}

function run(readers: ObserverReaders, observationOrder?: "state_guided", workUnits = 10_000, maxTurns = 100) {
  const trace: ReadTrace[] = [];
  const cost = new RequestCostLedger();
  const relation = readers.relation!;
  const metered: ObserverReaders = { ...readers, relation: (request) => {
    const page = relation(request);
    trace.push({ subject: request.subject, predicate: request.predicate,
      rows: page.rowsRead, bytes: page.bytesRead });
    return page;
  } };
  const request: ObserveFieldInput = { workspace_id: WS, query_text: "seed", as_of: AS_OF,
    readers: metered, authorized_scopes: null,
    budget: defaultBudget({ work_units: workUnits, memory_bytes: 1_000_000 }), cost,
    ...(observationOrder === undefined ? {} : { observation_order: observationOrder }) };
  let state: FieldEngineState | undefined;
  let turns = 0;
  do {
    state = observeField(interpretation(), { ...request, ...(state === undefined ? {} : { resume_field: state }) });
    turns += 1;
  } while (needsResume(state) && turns < maxTurns);
  if (maxTurns > 1) expect(needsResume(state)).toBe(false);
  return { state, trace, turns, cost: cost.snapshot() };
}

function needsResume(state: FieldEngineState): boolean {
  return state.pending_path_effects !== undefined || state.residuals.some((region) =>
    (region.kind === "seed" || region.kind === "adjacency") &&
    (region.status === "open" || region.status === "interrupted"));
}

function accepting(state: FieldEngineState): string[] {
  if (state.binding.kind !== "bound") return [];
  return state.binding.snapshot.values.filter((row) => row.accepting && (row.milligrades ?? 0) > 0)
    .map((row) => productSubjectId(row.state)).sort();
}

function semantic(state: FieldEngineState) {
  const sorted = (values: readonly unknown[]) => values.map((row) => JSON.stringify(row)).sort();
  return {
    closure: state.closure,
    residuals: sorted(state.residuals),
    support: sorted(state.support),
    values: state.binding.kind === "bound" ? sorted(state.binding.snapshot.values) : [],
    transitions: state.binding.kind === "bound" ? sorted(state.binding.snapshot.retained_transitions) : []
  };
}

function report(label: string, scan: ReturnType<typeof run>, guided: ReturnType<typeof run>): void {
  if (process.env.STATE_OBSERVATION_EVIDENCE !== "1") return;
  console.info(JSON.stringify({ label, scan: summary(scan), guided: summary(guided) }));
}

function summary(result: ReturnType<typeof run>) {
  return { turns: result.turns, accepting: accepting(result.state), closure: result.state.closure,
    trace: result.trace, native_visits: result.cost.native_visits, native_bytes: result.cost.native_bytes,
    adjacency_joins: result.cost.phases.adjacency.joins,
    demand_bytes: result.cost.phases.adjacency.charged_retained_bytes,
    remaining_exploration: result.state.remaining_exploration };
}
