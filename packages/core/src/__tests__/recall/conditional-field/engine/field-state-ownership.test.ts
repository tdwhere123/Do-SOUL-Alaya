import { describe, expect, it } from "vitest";
import type { ObserverPage, QueryInterpretation, Transition } from "@do-soul/alaya-protocol";
import {
  applyEvidenceEffect,
  applyObserverPage,
  createConditionalField,
  type FieldObservationEffect
} from "../../../../recall/conditional-field/engine/field-engine.js";
import { absorbObservations } from "../../../../recall/conditional-field/engine/field-update.js";
import { indexedIdentityWork } from "../../../../recall/conditional-field/engine/state-endpoint-index.js";
import {
  QUERY_ID,
  SNAPSHOT_ID,
  defaultBudget,
  defaultView,
  deploymentProgram,
  productKey
} from "../reference/deployment.fixture.js";

const validity = { kind: "open", valid_from: "2026-01-01T00:00:00.000Z" } as const;

function createField(status: QueryInterpretation["status"] = "resolved") {
  return createConditionalField({
    interpretation: {
      schema_version: 1,
      query_id: QUERY_ID,
      snapshot_id: SNAPSHOT_ID,
      status,
      program: deploymentProgram(),
      view: defaultView(),
      holes: [],
      hypotheses: []
    },
    budget: defaultBudget(),
    seeds: [{ schema_version: 1, state: productKey("root"), milligrades: 1000 }]
  });
}

function page(ids: readonly string[] = []): ObserverPage {
  return {
    schema_version: 1,
    query_id: QUERY_ID,
    snapshot_id: SNAPSHOT_ID,
    cursor: {
      schema_version: 1,
      query_id: QUERY_ID,
      snapshot_id: SNAPSHOT_ID,
      cursor_id: "adjacency",
      region_id: "adjacency",
      position: null,
      committed_through: null
    },
    observations: ids.map(id => ({
      schema_version: 1,
      observation_id: id,
      object_id: id,
      source_revision: "rev",
      workspace_id: "ws",
      applicability: {
        schema_version: 1,
        kind: "query_predicate",
        verdict: "true",
        time_scope: "none"
      }
    })),
    outcome: { schema_version: 1, status: "open" },
    open_regions: []
  };
}

function transition(id: string, applicable: boolean): Transition {
  return {
    schema_version: 1,
    from: productKey("root"),
    to: productKey(id),
    relation_kind: id,
    strength_milligrades: 1000,
    applicable,
    validity
  };
}

function joinedEffect(id: string): FieldObservationEffect {
  return {
    observation_id: id,
    hyperedge: {
      from: productKey("root"),
      to: productKey(id),
      relation_kind: id,
      strength_milligrades: 1000,
      validity
    },
    hyperedge_premises: [
      { hypothesis_id: "h0", binding_context: "default", time_state: "as_of", present: true }
    ]
  };
}

describe("field state ownership", () => {
  it("reuses unchanged support and claims while isolating evidence updates between branches", () => {
    const initial = createField();
    const record = { schema_version: 1 as const, proposition_id: "root", claim: "unknown" as const, witnesses: [] };
    const first = applyEvidenceEffect(initial, {
      support: [record],
      claims: new Map([["root", "unknown"]])
    });
    expect(initial.support).toEqual([]);
    expect(initial.claims.size).toBe(0);
    expect(first.support[0]).toBe(record);
    expect(first.claims.get("root")).toBe("unknown");

    const unchanged = applyEvidenceEffect(first, {
      support: [record], claims: new Map([["root", "unknown"]]), work_status: "open"
    });
    expect(unchanged.support).toBe(first.support);
    expect(unchanged.claims).toBe(first.claims);
    expect(unchanged.support_work_status).toBe("open");
    const empty = applyEvidenceEffect(first, { support: [], claims: new Map() });
    expect(empty.support).toBe(first.support);
    expect(empty.claims).toBe(first.claims);

    const replacement = { ...record, claim: "supported" as const };
    const changed = applyEvidenceEffect(first, {
      support: [replacement], claims: new Map([["root", "supported"]])
    });
    expect(changed.support).toEqual([replacement]);
    expect(Object.isFrozen(changed.support)).toBe(true);
    expect(changed.claims.get("root")).toBe("supported");
    expect(first.support).toEqual([record]);
    expect(first.claims.get("root")).toBe("unknown");

    const restored = applyEvidenceEffect(first, { support: [replacement, record] });
    expect(restored.support).toEqual([record]);
    expect(restored.support).not.toBe(first.support);
  });

  it("derives guaranteed transitions from retained ordinary and completed join rows", () => {
    const initial = createField();
    const effects = [
      { observation_id: "accepted", transition: transition("accepted", true) },
      { observation_id: "pending", transition: transition("pending", false) },
      joinedEffect("joined")
    ];
    const consumption = { page: page(["accepted", "pending", "joined"]), effects };
    const applied = applyObserverPage(initial, consumption);

    expect(applied.retention_rejected).toBeUndefined();
    expect(applied.transitions.map(row => row.relation_kind)).toEqual(["accepted", "pending", "joined"]);
    expect(applied.guaranteed_transitions.map(row => row.relation_kind)).toEqual(["accepted", "joined"]);
    expect(initial.transitions).toHaveLength(0);
    expect(initial.observations).toHaveLength(0);

    const repeated = applyObserverPage(applied, consumption);
    expect(repeated.transitions.map(row => row.relation_kind)).toEqual(["accepted", "pending", "joined"]);
    expect(repeated.guaranteed_transitions.map(row => row.relation_kind)).toEqual(["accepted", "joined"]);
    expect(repeated.observations).toHaveLength(3);
    expect(repeated.remaining_work).toEqual(applied.remaining_work);
  });

  it("records each unfunded join and observer work on the same pending-work ledger", () => {
    const initial = { ...createField(), remaining_exploration: 0, remaining_work: [] };
    const absorbed = absorbObservations(initial, {
      page: page(),
      effects: [joinedEffect("first"), joinedEffect("second")],
      work: { work_units: 3 }
    });

    expect(absorbed.remaining_exploration).toBe(0);
    expect(absorbed.remaining_work).toEqual([
      { kind: "join", units: 1 },
      { kind: "join", units: 1 },
      { kind: "state_create", units: 3 }
    ]);
    expect(absorbed.guaranteed_transitions.map(row => row.relation_kind)).toEqual(["first", "second"]);
    expect(initial.remaining_work).toEqual([]);
    expect(initial.transitions).toHaveLength(0);
  });

  it("keeps rejected page additions out of the prior branch and permits a funded retry", () => {
    const initial = createField();
    const consumption = {
      page: page(["accepted"]),
      effects: [{ observation_id: "accepted", transition: transition("accepted", true) }]
    };
    const rejected = applyObserverPage({ ...initial, remaining_memory_bytes: 1 }, consumption);

    expect(rejected.retention_rejected).toBe("memory");
    expect(rejected.transitions).toBe(initial.transitions);
    expect(rejected.observations).toBe(initial.observations);
    expect(rejected.transition_derivations).toBe(initial.transition_derivations);
    const retried = applyObserverPage(initial, consumption);
    expect(retried.retention_rejected).toBeUndefined();
    expect(retried.guaranteed_transitions.map(row => row.relation_kind)).toEqual(["accepted"]);
    expect(rejected.guaranteed_transitions).toHaveLength(0);
  });

  it("settles work and cumulative allocation when a partially solved observation page rolls back", () => {
    const settled = createField();
    const paused = applyObserverPage({ ...settled, remaining_exploration: indexedIdentityWork(settled) + 1, remaining_reserve: 0 }, {
      page: page(),
      effects: [{ observation_id: "partial", transition: transition("partial", true) }]
    });
    expect(paused.retention_rejected).toBeUndefined();
    expect(paused.remaining_work.some(work => work.kind === "relaxation")).toBe(true);
    const initial = { ...paused, remaining_reserve: 1 };
    const rejected = applyObserverPage(initial, { page: page(), work: { work_units: 1 } });
    expect(rejected.retention_rejected).toBe("work");
    expect(rejected.binding).toBe(initial.binding);
    expect(rejected.remaining_memory_bytes).toBe(initial.remaining_memory_bytes);
    expect(rejected.remaining_exploration).toBe(0);
    expect(rejected.remaining_reserve).toBe(0);
    expect(rejected.solver_completed_work).toBe((initial.solver_completed_work ?? 0) + 1);
    expect(rejected.solver_retained_work).toBe(initial.solver_retained_work);
    expect(rejected.admitted_allocation_bytes).toBeGreaterThan(initial.admitted_allocation_bytes);
  });

  it.each(["resolved", "unsupported"] as const)("initializes independent routing progress for %s fields", status => {
    const first = createField(status);
    const second = createField(status);
    expect(first.binding.kind).toBe(status === "resolved" ? "bound" : "resource_rejected");
    expect(first).toMatchObject({
      resume_cursors: {},
      pair_demand_bytes: 0,
      pair_progress_bytes: 0,
      source_fact_demand_bytes: 0,
      source_fact_pending_count: 0,
      source_fact_scan_offset: 0,
      pair_completed_count: 0,
      pair_revision: 0,
      pair_scan_offset: 0
    });
    for (const key of ["pair_progress", "pair_demands", "source_fact_demands"] as const) {
      expect(first[key].size).toBe(0);
      expect(first[key]).not.toBe(second[key]);
    }
    expect(first.resume_subjects.size).toBe(status === "resolved" ? 1 : 0);
    expect(first.resume_subjects).not.toBe(second.resume_subjects);
    expect(first.resume_cursors).not.toBe(second.resume_cursors);
    expect(second.pair_demands.with("one-branch-only", true).get("one-branch-only")).toBe(true);
    expect(first.pair_demands.get("one-branch-only")).toBeUndefined();
  });
});
