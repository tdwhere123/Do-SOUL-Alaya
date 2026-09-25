import { describe, expect, it } from "vitest";
import type { QueryInterpretation } from "@do-soul/alaya-protocol";
import {
  retainedFieldLevels,
  snapshotRestoredEngineWork,
  thisRequestObservedWork
} from "../../../recall/runtime/request-cost-engine-snapshot.js";
import { observeField } from "../../../recall/runtime/conditional-field-observe.js";
import type { ObserverReaders } from "../../../recall/conditional-field/observers/observe.js";
import { defaultBudget, defaultView, SNAPSHOT_ID } from "../conditional-field/reference/deployment.fixture.js";

const remaining = (units: number) => [{ units }];

describe("request-cost engine work snapshot", () => {
  it("bills solver and identity deltas, not retained length or leftover remaining bytes", () => {
    const restored = {
      solver_completed_work: 12,
      seen_identities: { length: 8 },
      remaining_memory_bytes: 40,
      remaining_work: remaining(5),
      pending_path_effects: { retained_bytes: 20 }
    };
    const before = snapshotRestoredEngineWork(restored, 1_000);
    expect(before.solver_completed_work).toBe(12);
    expect(before.charged_identities).toBe(8);
    expect(before.remaining_memory_bytes).toBe(980);

    const idle = thisRequestObservedWork(restored, { ...restored, remaining_memory_bytes: 980 }, 1_000);
    expect(idle.relaxations).toBe(0);
    expect(idle.state_creates).toBe(0);
    expect(idle.charged_retained_bytes).toBe(0);
    expect(idle.pending_work).toBe(5);

    const progressed = thisRequestObservedWork(restored, {
      solver_completed_work: 15,
      seen_identities: { length: 9 },
      remaining_memory_bytes: 900,
      remaining_work: remaining(2)
    }, 1_000);
    expect(progressed.relaxations).toBe(3);
    expect(progressed.state_creates).toBe(1);
    expect(progressed.charged_retained_bytes).toBe(80);
    expect(progressed.pending_work).toBe(2);
  });

  it("starts a first page from empty meters and treats remaining work as leftover", () => {
    const field = {
      solver_completed_work: 7,
      seen_identities: { length: 4 },
      remaining_memory_bytes: 750,
      remaining_work: remaining(9)
    };
    const delta = thisRequestObservedWork(undefined, field, 1_000);
    expect(delta.relaxations).toBe(7);
    expect(delta.state_creates).toBe(4);
    expect(delta.charged_retained_bytes).toBe(250);
    expect(delta.pending_work).toBe(9);
    expect(delta.state_creates).not.toBe(field.remaining_work[0]!.units);
    expect(retainedFieldLevels(field, 1_000)).toEqual({
      retained_states_current: 4,
      retained_bytes_current: 250
    });
  });

  it("does not bill a negative solver or identity delta when retained shrinks", () => {
    const restored = {
      solver_completed_work: 10,
      seen_identities: { length: 6 },
      remaining_memory_bytes: 500,
      remaining_work: remaining(1)
    };
    const delta = thisRequestObservedWork(restored, {
      solver_completed_work: 8,
      seen_identities: { length: 3 },
      remaining_memory_bytes: 500,
      remaining_work: remaining(1)
    }, 500);
    expect(delta.relaxations).toBe(0);
    expect(delta.state_creates).toBe(0);
    expect(delta.charged_retained_bytes).toBe(0);
  });

  it("restores pending preparation once and charges only new retention", () => {
    const prepared = {
      solver_completed_work: 3, seen_identities: { length: 2 }, remaining_memory_bytes: 1,
      remaining_work: remaining(0), pending_path_effects: { retained_bytes: 11, preparation: { retained_bytes: 136 } },
      binding_context_bytes: 0, binding_contexts: { bytes: 90 }, solver_retained_bytes: 17,
      support_retained_bytes: 13,
      pair_demand_bytes: 19, pair_progress_bytes: 23, source_fact_demand_bytes: 29,
      source_fact_bytes: 31, observed_relation_bytes: 37, compiled_automaton_bytes: 41
    };
    const restored = snapshotRestoredEngineWork(prepared, 1_000);
    expect(restored.remaining_memory_bytes).toBe(643);
    expect(thisRequestObservedWork(prepared, { ...prepared, remaining_memory_bytes: 643 }, 1_000)
      .charged_retained_bytes).toBe(0);
    const added = { ...prepared, remaining_memory_bytes: 596 };
    expect(thisRequestObservedWork(prepared, added, 1_000).charged_retained_bytes).toBe(47);
    expect(retainedFieldLevels(added, 1_000)).toEqual({ retained_states_current: 2, retained_bytes_current: 404 });
    const legacy = { ...prepared, binding_context_bytes: undefined };
    expect(snapshotRestoredEngineWork(legacy, 1_000).remaining_memory_bytes).toBe(553);
  });

  it("does not rebill retained path preparation on a zero-exploration continuation", () => {
    const asOf = "2026-09-07T00:00:00.000Z";
    const interpretation: QueryInterpretation = { schema_version: 1, query_id: "retained-preparation",
      snapshot_id: SNAPSHOT_ID, status: "resolved", holes: [], hypotheses: [], view: defaultView(),
      program: { schema_version: 1, kind: "relation", relation_kind: "p", source_variable: "s", target_variable: "t",
        facet_mode: "same_path", threshold_milligrades: 0,
        guard: { schema_version: 1, kind: "query_predicate", time_scope: "none", verdict: "unresolved" } } };
    const calls: string[] = [];
    const readers: ObserverReaders = {
      snapshotPin: () => { calls.push("pin"); return { source_revision: "old" }; },
      lexical: () => { calls.push("lexical"); return { ids: ["a"], nativeVisits: 1, nativeBytes: 1,
        rowsRead: 1, bytesRead: 1, truncated: false }; },
      source: ({ objectId }) => { calls.push(`source:${objectId}`); return { row: { object_id: objectId,
        sourceRevision: "rev", lifecycle_state: "active", scope_class: "project" },
        rowsRead: 1, bytesRead: 32, unavailable: false }; },
      relation: ({ subject, predicate, afterAssertionId }) => {
        calls.push(`${subject}:${predicate}`);
        const observations = subject === "a" && predicate === "p" ? [{ assertionId: "a-b", sourceObjectId: "a",
          targetObjectId: "b", resultObjectId: "b", predicate: "p", source_revision: "rev",
          validity: { kind: "open" as const, valid_from: "2026-01-01T00:00:00.000Z" },
          sourceObservations: [{ source_id: "event", source_sha256: "rev" }],
          evidenceReceipts: [{ evidenceId: "ev", eventId: "event", eventType: "test", occurredAt: asOf }] }] : [];
        return { observations, nativeVisits: observations.length, nativeBytes: 32 * observations.length,
          rowsRead: observations.length, bytesRead: 32 * observations.length, truncated: false,
          committedThrough: observations.at(-1)?.assertionId ?? afterAssertionId };
      }
    };
    const request = { workspace_id: "ws", query_text: "a", as_of: asOf, authorized_scopes: null, readers };
    const first = observeField(interpretation, { ...request, budget: defaultBudget({ work_units: 127, memory_bytes: 1_000_000 }) });
    expect(first.pending_path_effects?.preparation?.retained_bytes).toBe(136);
    const before = snapshotRestoredEngineWork(first, 1_000_000);
    calls.length = 0;
    const next = observeField(interpretation, { ...request, resume_field: first,
      budget: defaultBudget({ work_units: 100, memory_bytes: 1_000_000 }) });
    expect(calls).toEqual([]);
    expect(next.solver_completed_work).toBe(first.solver_completed_work);
    expect(next.seen_identities.length).toBe(first.seen_identities.length);
    expect(next.remaining_memory_bytes).toBe(before.remaining_memory_bytes);
    expect(thisRequestObservedWork(first, next, 1_000_000)).toMatchObject({ relaxations: 0,
      state_creates: 0, charged_retained_bytes: 0 });
    expect(retainedFieldLevels(next, 1_000_000).retained_bytes_current)
      .toBe(1_000_000 - before.remaining_memory_bytes);
  });
});
