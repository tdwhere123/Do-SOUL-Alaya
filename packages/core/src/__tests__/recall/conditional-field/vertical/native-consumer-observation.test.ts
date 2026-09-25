import { describe, expect, it } from "vitest";
import { MemoryDimension, productSubjectId, type QueryInterpretation } from "@do-soul/alaya-protocol";
import { createConditionalFieldObserverReaders } from "../../../../../../../apps/core-daemon/src/runtime/recall-read-worker/observer-operations.js";
import { observeField, type ObserveFieldInput } from "../../../../recall/runtime/conditional-field-observe.js";
import { RequestCostLedger, type RequestCostDelta, type RequestCostPhase } from "../../../../recall/runtime/request-cost-ledger.js";
import { defaultBudget, defaultView, SNAPSHOT_ID } from "../reference/deployment.fixture.js";
import { openSourceSlice, MEM, WS } from "./source-slice.js";

const relation = (kind: string, source: string, target: string) => ({
  schema_version: 1, kind: "relation", relation_kind: kind,
  source_variable: source, target_variable: target, facet_mode: "same_path",
  threshold_milligrades: 0,
  guard: { schema_version: 1, kind: "query_predicate", verdict: "unresolved", time_scope: "none" }
}) as const;

const interpretation = {
  schema_version: 1, query_id: "state-guided-typed-observation", snapshot_id: SNAPSHOT_ID,
  status: "resolved", holes: [], hypotheses: [], view: defaultView(),
  program: { schema_version: 1, kind: "alternative", options: [
    { schema_version: 1, kind: "sequence", steps: [
      relation("observed_log", "s", "m"), relation("config_direct", "m", "e")
    ] }, relation("service_history", "s", "e")
  ] }
} as QueryInterpretation;

class ObservationCostTrace extends RequestCostLedger {
  public readonly joins: { phase: RequestCostPhase; work: number }[] = [];
  public override add(phase: RequestCostPhase, delta: RequestCostDelta): void {
    if ((delta.joins ?? 0) > 0) this.joins.push({ phase, work: delta.joins! });
    super.add(phase, delta);
  }
}

describe("native consumer-directed observation", () => {
  it.each(["a", "b"] as const)("uses the frozen SQLite variant %s", async (variant) => {
    let database: Awaited<ReturnType<typeof openSourceSlice>>["database"] | undefined;
    const slice = await openSourceSlice((opened) => { database = opened; });
    try {
      for (const [index, id] of [MEM.r, MEM.s, MEM.l, MEM.h, MEM.c, MEM.p].entries()) {
        await slice.writeMemory(id, `observation node ${index}`, MemoryDimension.FACT);
      }
      const links = variant === "a"
        ? [[MEM.r, MEM.l, "observed_log"], [MEM.l, MEM.c, "config_direct"]]
        : [[MEM.s, MEM.h, "observed_log"], [MEM.h, MEM.p, "config_direct"]];
      for (const [index, [sourceId, targetId, relationKind]] of links.entries()) {
        await slice.admitRelation({
          evidenceId: `bbbbbbbb-bbbb-4bbb-8bbb-0000000003${String(index).padStart(2, "0")}`,
          assertionId: `state-observation-${index}`, sourceId: sourceId!, targetId: targetId!,
          resultObjectId: targetId!, relationKind: relationKind!,
          validity: { kind: "open", valid_from: "2026-01-01T00:00:00.000Z" }, gist: `relation ${index}`
        });
      }
      const native = createConditionalFieldObserverReaders(database!);
      for (const workUnits of [10_000, 500]) {
        const cost = new ObservationCostTrace();
        const trace: { subject: string; predicate: string; rows: number; bytes: number }[] = [];
        const request: ObserveFieldInput = {
          workspace_id: WS, query_text: "seed", as_of: "2026-09-07T00:00:00.000Z",
          readers: { lexical: () => ({ ids: [MEM.r, MEM.s], nativeVisits: 2, nativeBytes: 2,
            rowsRead: 2, bytesRead: 2, truncated: false }), source: native.source,
          relation: (request) => {
            const page = native.relation!(request);
            trace.push({ subject: request.subject ?? "", predicate: request.predicate,
              rows: page.rowsRead, bytes: page.bytesRead });
            return page;
          } },
          authorized_scopes: null,
          budget: defaultBudget({ work_units: workUnits, memory_bytes: 1_000_000 }), cost
        };
        let state = observeField(interpretation, request);
        const accepting = state.binding.kind === "bound" ? state.binding.snapshot.values
          .filter((value) => value.accepting && (value.milligrades ?? 0) > 0)
          .map((value) => productSubjectId(value.state)).sort() : [];
        console.info(JSON.stringify({ label: `native-demand-${variant}-${workUnits}`, trace, accepting,
          transitions: state.transitions.length, identities: state.seen_identities.length,
          facets: state.facets.length, pairDemands: state.pair_demands.size,
          pathPending: state.pending_path_effects?.offset, support: state.support.length,
          claims: state.claims.size, evidence: state.support.length,
          closure: state.closure, residuals: state.residuals,
          workConsumed: workUnits - (defaultBudget({ work_units: workUnits }).finalization_reserve ?? 0)
            - state.remaining_exploration, retainedBytes: 1_000_000 - state.remaining_memory_bytes,
          nativeVisits: cost.snapshot().native_visits, nativeBytes: cost.snapshot().native_bytes,
          adjacencyJoins: cost.snapshot().phases.adjacency.joins, joinEvents: cost.joins }));
        if (workUnits === 10_000) expect(accepting).toContain(variant === "a" ? MEM.c : MEM.p);
        expect(trace.filter((row) => row.rows > 0)).toHaveLength(2);
        expect(trace.every((row) => ["observed_log", "config_direct", "service_history", "uses_service"].includes(row.predicate))).toBe(true);
        expect(state.remaining_exploration).toBeGreaterThanOrEqual(0);
        if (workUnits === 500) {
          const completed = new Set(trace.map((row) => `${row.subject}\0${row.predicate}`));
          trace.length = 0;
          state = observeField(interpretation, { ...request, resume_field: state });
          expect(trace.every((row) => !completed.has(`${row.subject}\0${row.predicate}`))).toBe(true);
          expect(state.binding.kind === "bound" && state.binding.snapshot.values.some((value) =>
            value.accepting && productSubjectId(value.state) === (variant === "a" ? MEM.c : MEM.p))).toBe(true);
          console.info(JSON.stringify({ label: `native-demand-${variant}-resume`, trace,
            adjacency: state.residuals.find((row) => row.kind === "adjacency")?.status,
            workConsumed: 400 - state.remaining_exploration }));
        }
      }
    } finally { database?.close(); }
  });
});
