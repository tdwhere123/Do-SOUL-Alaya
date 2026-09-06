import { describe, expect, it } from "vitest";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  QueryProgramSchema,
  type FacetVector,
  type ProductStateKey,
  type SeedActivation,
  type Transition,
  type Witness
} from "@do-soul/alaya-protocol";
import {
  evaluateFacetPredicate,
  joinHyperedgeAnd,
  joinHyperedgeOr,
  projectAcceptingIndex,
  selectFeasibleWitnesses
} from "../../../../recall/conditional-field/reference/accepting-projection.js";
import {
  bindMaxMinField
} from "../../../../recall/conditional-field/reference/bind-max-min.js";
import {
  QUERY_ID,
  RESULT_VERSION,
  SNAPSHOT_ID,
  collectTimeScopedVariables,
  defaultBudget,
  defaultView,
  deploymentProgram,
  deploymentSeeds,
  deploymentTransitions,
  productKey
} from "./deployment.fixture.js";

describe("conditional-field reference binder", () => {
  it("A01 indexes last-week config at 850 without applying yesterday to every object", () => {
    const bound = bindDeployment();
    const index = projectBound(bound);
    const config = index.entries.find((entry) => entry.object_id === "c");
    expect(config?.association_milligrades).toBe(850);
    expect(collectTimeScopedVariables(deploymentProgram())).toEqual(["r"]);
    expect(collectTimeScopedVariables(deploymentProgram())).not.toContain("c");
  });

  it("A02 includes prior same-service failure at 550 with unknown common cause", () => {
    const bound = bindDeployment();
    const index = projectAcceptingIndex({
      snapshot: bound.snapshot,
      view: defaultView(),
      query_id: QUERY_ID,
      snapshot_id: SNAPSHOT_ID,
      result_version: RESULT_VERSION,
      budget: defaultBudget(),
      roles: new Map([
        ["r", "requested"],
        ["l", "associated"],
        ["c", "associated"],
        ["s", "routing_only"],
        ["h", "associated"]
      ]),
      claims: new Map([["h", "unknown"], ["c", "unknown"]])
    });
    const history = index.entries.find((entry) => entry.object_id === "h");
    expect(history?.association_milligrades).toBe(550);
    expect(history?.claim).toBe("unknown");
    expect(index.entries.find((entry) => entry.object_id === "s")).toBeUndefined();
  });

  it("A03 keeps epsilon distinct from empty and does not pool hypotheses", () => {
    const epsilon = QueryProgramSchema.parse({ schema_version: 1, kind: "epsilon" });
    const empty = QueryProgramSchema.parse({ schema_version: 1, kind: "empty" });
    expect(epsilon.kind).not.toBe(empty.kind);
    const first = productKey("c", "h1");
    const second = productKey("c", "h2");
    const bound = bindMaxMinField({
      query_id: QUERY_ID,
      snapshot_id: SNAPSHOT_ID,
      budget: defaultBudget(),
      seeds: [
        seed(first, 850),
        seed(second, 400)
      ],
      transitions: []
    });
    if (bound.kind !== "bound") throw new Error("expected bound field");
    const index = projectAcceptingIndex({
      snapshot: bound.snapshot,
      view: defaultView(),
      query_id: QUERY_ID,
      snapshot_id: SNAPSHOT_ID,
      result_version: RESULT_VERSION,
      budget: defaultBudget(),
      roles: new Map([["c", "associated"]])
    });
    const rows = index.entries.filter((entry) => entry.object_id === "c");
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.hypothesis_id).sort()).toEqual(["h1", "h2"]);
    expect(rows.find((row) => row.hypothesis_id === "h1")?.association_milligrades).toBe(850);
    expect(rows.find((row) => row.hypothesis_id === "h2")?.association_milligrades).toBe(400);
  });

  it("A04 keeps long homogeneous chains and fan-out grades without hop attenuation", () => {
    const hops: Transition[] = [];
    const seeds: SeedActivation[] = [seed(productKey("n0"), 900)];
    for (let index = 0; index < 20; index += 1) {
      hops.push(edge(productKey(`n${index}`), productKey(`n${index + 1}`), "chain", 900, true));
    }
    const histories: Transition[] = [];
    for (let index = 0; index < 8; index += 1) {
      histories.push(edge(productKey("s"), productKey(`h${index}`), "service_history", 550, true));
    }
    const bound = bindMaxMinField({
      query_id: QUERY_ID,
      snapshot_id: SNAPSHOT_ID,
      budget: defaultBudget(),
      seeds: [...seeds, seed(productKey("s"), 900)],
      transitions: [...hops, ...histories]
    });
    if (bound.kind !== "bound") throw new Error("expected bound field");
    expect(valueOf(bound.snapshot.values, "n20")).toBe(900);
    for (let index = 0; index < 8; index += 1) {
      expect(valueOf(bound.snapshot.values, `h${index}`)).toBe(550);
    }
  });

  it("A05 agrees with an independent enumerator on the deployment graph", () => {
    const bound = bindDeployment();
    const enumerated = enumerateBottleneck(deploymentSeeds(), deploymentTransitions());
    for (const objectId of ["r", "l", "c", "s", "h"]) {
      expect(valueOf(bound.snapshot.values, objectId)).toBe(enumerated.get(objectId));
    }
    expect(valueOf(bound.snapshot.values, "u")).toBe(0);
    expect(bound.snapshot.retained_transitions.some((transition) => transition.to.object_id === "u"))
      .toBe(false);
  });

  it("A06 rejects coordinate-wise max under same_path", () => {
    const vectors: FacetVector[] = [
      { schema_version: 1, path_id: "p1", coordinates: [900, 200] },
      { schema_version: 1, path_id: "p2", coordinates: [200, 900] }
    ];
    expect(evaluateFacetPredicate("same_path", vectors, 800)).toBe(false);
    expect(evaluateFacetPredicate("independent", vectors, 800)).toBe(true);
  });

  it("A07 requires all AND premises and keeps both OR witnesses", () => {
    expect(joinHyperedgeAnd([true, false])).toBe(false);
    expect(joinHyperedgeAnd([true, true])).toBe(true);
    const witnesses: Witness[] = [
      { schema_version: 1, witness_id: "w-and", premises: ["p1", "p2"], cost: 400, complete: true },
      { schema_version: 1, witness_id: "w-partial", premises: ["p1"], cost: 100, complete: false }
    ];
    expect(joinHyperedgeOr(witnesses).map((witness) => witness.witness_id)).toEqual(["w-and"]);
  });

  it("A08 keeps the cheap complete witness under a page budget of 800", () => {
    const witnesses: Witness[] = [
      { schema_version: 1, witness_id: "expensive", premises: ["a"], cost: 1200, complete: true },
      { schema_version: 1, witness_id: "cheap", premises: ["b"], cost: 400, complete: true }
    ];
    expect(selectFeasibleWitnesses(witnesses, 800).map((witness) => witness.witness_id))
      .toEqual(["cheap"]);
  });

  it("rejects an envelope that cannot fit instead of a complete empty index", () => {
    const rejected = bindMaxMinField({
      query_id: QUERY_ID,
      snapshot_id: SNAPSHOT_ID,
      budget: defaultBudget({ min_envelope: 900, page_budget: 800 }),
      seeds: deploymentSeeds(),
      transitions: deploymentTransitions()
    });
    expect(rejected.kind).toBe("resource_rejected");
    if (rejected.kind !== "resource_rejected") return;
    expect(rejected.completeness.logical_index).toBe("resource_rejected");
  });
});

function bindDeployment() {
  const bound = bindMaxMinField({
    query_id: QUERY_ID,
    snapshot_id: SNAPSHOT_ID,
    budget: defaultBudget(),
    seeds: deploymentSeeds(),
    transitions: deploymentTransitions()
  });
  if (bound.kind !== "bound") throw new Error("expected bound field");
  return bound;
}

function projectBound(bound: ReturnType<typeof bindDeployment>) {
  return projectAcceptingIndex({
    snapshot: bound.snapshot,
    view: defaultView(),
    query_id: QUERY_ID,
    snapshot_id: SNAPSHOT_ID,
    result_version: RESULT_VERSION,
    budget: defaultBudget(),
    roles: new Map([
      ["r", "requested"],
      ["l", "associated"],
      ["c", "associated"],
      ["s", "routing_only"],
      ["h", "associated"]
    ])
  });
}

function seed(state: ProductStateKey, milligrades: number): SeedActivation {
  return { schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, state, milligrades };
}

function edge(
  from: ProductStateKey,
  to: ProductStateKey,
  relationKind: string,
  strength: number,
  applicable: boolean
): Transition {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    from,
    to,
    relation_kind: relationKind,
    strength_milligrades: strength,
    validity: { kind: "open", valid_from: "2026-01-01T00:00:00.000Z" },
    applicable
  };
}

function valueOf(
  values: readonly { readonly state: ProductStateKey; readonly milligrades: number }[],
  objectId: string
): number {
  return values.find((value) => value.state.object_id === objectId)?.milligrades ?? 0;
}

function enumerateBottleneck(
  seeds: readonly SeedActivation[],
  transitions: readonly Transition[]
): Map<string, number> {
  const best = new Map<string, number>();
  const edges = new Map<string, Array<{ to: string; strength: number }>>();
  for (const seedRow of seeds) best.set(seedRow.state.object_id, seedRow.milligrades);
  for (const transition of transitions) {
    if (!transition.applicable) continue;
    const from = transition.from.object_id;
    const to = transition.to.object_id;
    if (!best.has(from)) best.set(from, 0);
    if (!best.has(to)) best.set(to, 0);
    const outgoing = edges.get(from) ?? [];
    outgoing.push({ to, strength: transition.strength_milligrades });
    edges.set(from, outgoing);
  }
  for (const seedRow of seeds) {
    visit(seedRow.state.object_id, seedRow.milligrades, new Set([seedRow.state.object_id]), best, edges);
  }
  return best;
}

function visit(
  nodeId: string,
  strength: number,
  seen: ReadonlySet<string>,
  best: Map<string, number>,
  edges: ReadonlyMap<string, readonly { to: string; strength: number }[]>
): void {
  best.set(nodeId, Math.max(best.get(nodeId) ?? 0, strength));
  for (const edgeRow of edges.get(nodeId) ?? []) {
    if (seen.has(edgeRow.to)) continue;
    visit(edgeRow.to, Math.min(strength, edgeRow.strength), new Set(seen).add(edgeRow.to), best, edges);
  }
}
