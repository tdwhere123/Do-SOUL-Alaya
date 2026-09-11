import { describe, expect, it } from "vitest";
import { PersistentStringMap } from "@do-soul/alaya-graph-algorithms";
import { productSubjectId, type QueryInterpretation } from "@do-soul/alaya-protocol";
import { applyObserverPage, createConditionalField, withdrawDerivationLeaves, type FieldEngineState } from "../../../../recall/conditional-field/engine/field-engine.js";
import { adjacencyEffectsForRows, seedProgramStates } from "../../../../recall/conditional-field/engine/path-composition.js";
import type { BoundSourceFacts } from "../../../../recall/conditional-field/engine/binding-environment.js";
import { productStateNodeId } from "../../../../recall/conditional-field/reference/bind-max-min.js";
import { projectAcceptingIndex } from "../../../../recall/conditional-field/index/project-accepting-index.js";
import { assessUnknownCause } from "../../../../recall/runtime/semantic-attribution.js";
import { defaultBudget, defaultView, productKey, SNAPSHOT_ID } from "../reference/deployment.fixture.js";

const NOW = "2026-09-10T00:00:00.000Z";

function page(queryId: string, id: string) {
  return { schema_version: 1 as const, query_id: queryId, snapshot_id: SNAPSHOT_ID,
    cursor: { schema_version: 1 as const, cursor_id: "adjacency", region_id: "adjacency", query_id: queryId,
      snapshot_id: SNAPSHOT_ID, position: id, committed_through: id }, observations: [],
    outcome: { schema_version: 1 as const, status: "exhausted" as const }, open_regions: [] };
}

function field(grade: number): FieldEngineState {
  const interpretation: QueryInterpretation = { schema_version: 1, query_id: "claim-consumer", snapshot_id: SNAPSHOT_ID,
    status: "resolved", holes: [], hypotheses: [], view: defaultView(), program: { schema_version: 1, kind: "relation",
      relation_kind: "p", source_variable: "x", target_variable: "y", facet_mode: "same_path", threshold_milligrades: 0,
      guard: { schema_version: 1, kind: "query_predicate", verdict: "true", time_scope: "none" } } };
  const initial = createConditionalField({ interpretation, budget: defaultBudget(), seeds: seedProgramStates(interpretation.program)
    .map((state) => ({ schema_version: 1 as const, state: productKey("a", "h0", "unbound", state), milligrades: grade })) });
  const row = { assertionId: "assertion-p", sourceObjectId: "a", targetObjectId: "b", resultObjectId: "b", predicate: "p",
    source_revision: "rev", validity: { kind: "open" as const, valid_from: "2026-01-01T00:00:00.000Z" },
    evidenceReceipts: [{ evidenceId: "evidence-p", eventId: "event-p", eventType: "relation.evidence",
      occurredAt: "2026-09-06T00:00:00.000Z" }],
    sourceObservations: [{ source_id: "event-p", source_sha256: "rev" }] };
  const next = applyObserverPage(initial, { page: page(initial.query_id, "one"), effects: adjacencyEffectsForRows([row], {
    interpretation, asOf: NOW, liveStates: initial.seen_identities,
    sourceFacts: new Map(["a", "b"].map((object_id) => [object_id, { object_id, source_revision: "rev" }])),
    overlay: { p: { applicable: true, milligrades: 1000 } }
  }) });
  return { ...next, authorized_scopes: null, observed_relations: [row] };
}

function sourceFacts(
  entries: readonly (readonly [string, string])[]
): PersistentStringMap<BoundSourceFacts> {
  let map = new PersistentStringMap<BoundSourceFacts>();
  for (const [objectId, scopeClass] of entries) {
    map = map.with(objectId, { object_id: objectId, source_revision: "rev", scope_class: scopeClass });
  }
  return map;
}

function targetKey(state: FieldEngineState): string {
  if (state.binding.kind !== "bound") throw new Error("expected bound field");
  const value = state.binding.snapshot.values.find((value) => value.accepting && productSubjectId(value.state) === "b");
  if (value === undefined) throw new Error("expected reachable accepting target");
  return productStateNodeId(value.state);
}

describe("claim support dependencies through reassessment and projection", () => {
  it.each([0, 900])("assesses founded evidence independently of the association grade %s", (grade) => {
    const assessed = assessUnknownCause(field(grade), { as_of: NOW });
    expect(assessed.claims.get(targetKey(assessed))).toBe("supported");
  });

  it("does not resurrect a withdrawn claim through retained assessment progress or index delivery", () => {
    let before = assessUnknownCause(field(900), { as_of: NOW });
    expect(before.claims.get(targetKey(before))).toBe("supported");
    if (before.binding.kind !== "bound") throw new Error("expected bound field");
    const target = before.binding.snapshot.values.find((value) => productStateNodeId(value.state) === targetKey(before))!.state;
    before = applyObserverPage(before, { page: page(before.query_id, "weak"), effects: [{ observation_id: "independent-weak-seed",
      seed: { schema_version: 1, state: target, milligrades: 100 } }] });
    const withdrawn = withdrawDerivationLeaves(before, "assertion-p");
    const assessed = assessUnknownCause({ ...withdrawn, remaining_exploration: 1000 }, { as_of: NOW });
    expect(assessed.claims.get(targetKey(assessed)) ?? "unknown").toBe("unknown");
    if (assessed.binding.kind !== "bound") throw new Error("expected surviving weak target");
    const index = projectAcceptingIndex({ snapshot: assessed.binding.snapshot, view: assessed.interpretation.view,
      query_id: assessed.query_id, snapshot_id: assessed.snapshot_id, result_version: "after-withdrawal", budget: defaultBudget(),
      claims: assessed.claims });
    expect(index.entries.find((entry) => entry.object_id === "b")?.claim).toBe("unknown");
  });

  it("reassesses changed evidence validity even when row and receipt counts stay the same", () => {
    const before = assessUnknownCause(field(900), { as_of: NOW });
    expect(before.claims.get(targetKey(before))).toBe("supported");
    const revised = { ...before, observed_relations: [...before.observed_relations!].map((row) => ({ ...row,
      validity: { kind: "bounded" as const, valid_from: "2026-01-01T00:00:00.000Z", valid_to: "2026-02-01T00:00:00.000Z" }
    })) };
    const fresh = assessUnknownCause({ ...revised, support_dependency_revision: undefined }, { as_of: NOW });
    expect(fresh.claims.get(targetKey(fresh))).toBe("unknown");
    const resumed = assessUnknownCause(revised, { as_of: NOW });
    expect(resumed.claims.get(targetKey(resumed))).toBe(fresh.claims.get(targetKey(fresh)));
  });

  it("withdraws a claim-only assertion without revoking the independent association path", () => {
    const initial = field(900);
    const context = initial.observed_relations!.at(0)!;
    const configured: FieldEngineState = { ...initial, interpretation: { ...initial.interpretation,
      view: { ...initial.interpretation.view, claim_demands: [{ variable: "y", proposition_kind: "common_cause",
        argument_variables: ["x", "y"], required_claim: "any" }] } },
      observed_relations: [context, { ...context, assertionId: "cause-assertion", predicate: "common_cause",
        evidenceReceipts: [{ evidenceId: "cause-evidence", eventId: "cause-event", eventType: "relation.evidence",
          occurredAt: "2026-09-06T00:00:00.000Z" }] }] };
    const before = assessUnknownCause(configured, { as_of: NOW });
    const key = targetKey(before);
    expect(before.claim_propositions?.get(key)?.kind).toBe("common_cause");
    expect(before.claims.get(key)).toBe("supported");
    const after = assessUnknownCause(withdrawDerivationLeaves(before, "cause-assertion"), { as_of: NOW });
    expect(targetKey(after)).toBe(key);
    expect(after.claims.get(key) ?? "unknown").toBe("unknown");
  });

  it("admits named-scope evidence when only source and target objects are in-scope", () => {
    const named = {
      ...field(900),
      authorized_scopes: ["project"],
      source_facts: sourceFacts([["a", "project"], ["b", "project"]])
    };
    const assessed = assessUnknownCause(named, { as_of: NOW });
    expect(assessed.claims.get(targetKey(assessed))).toBe("supported");
  });

  it("keeps unrestricted local-daemon evidence eligible", () => {
    const unrestricted = {
      ...field(900),
      authorized_scopes: null,
      source_facts: sourceFacts([["a", "project"], ["b", "personal"]])
    };
    expect(assessUnknownCause(unrestricted, { as_of: NOW }).claims.get(targetKey(unrestricted))).toBe("supported");
  });

  it("fail-closes omitted or empty authorized_scopes even with in-scope objects", () => {
    const facts = sourceFacts([["a", "project"], ["b", "project"]]);
    const omitted = { ...field(900), authorized_scopes: undefined, source_facts: facts };
    const empty = { ...field(900), authorized_scopes: [], source_facts: facts };
    expect(assessUnknownCause(omitted, { as_of: NOW }).claims.get(targetKey(omitted)) ?? "unknown").toBe("unknown");
    expect(assessUnknownCause(empty, { as_of: NOW }).claims.get(targetKey(empty)) ?? "unknown").toBe("unknown");
  });
});
