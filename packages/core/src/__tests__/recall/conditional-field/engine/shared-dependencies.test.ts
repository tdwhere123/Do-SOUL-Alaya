import { describe, expect, it } from "vitest";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  memoryProductStateKey,
  productSubjectId,
  sharedProductIdentity,
  sourceProductStateKey,
  type FacetVector,
  type ObserverPage,
  type ProductStateKey,
  type QueryInterpretation,
  type SupportRecord,
  type Transition,
  type Witness
} from "@do-soul/alaya-protocol";
import {
  applyObserverPage,
  createConditionalField,
  withdrawDerivationLeaves
} from "../../../../recall/conditional-field/engine/field-engine.js";
import { groundedOutputDerivations } from "../../../../recall/conditional-field/engine/output-derivations.js";
import {
  joinDerivation,
  leafDerivation,
  seedDerivationIdentity,
  withdrawDerivation
} from "../../../../recall/conditional-field/engine/path-derivation.js";
import {
  composedFacetPathId,
  samePathAccepts,
  transitionKey
} from "../../../../recall/conditional-field/engine/path-composition.js";
import { recoverExplanationForest } from "../../../../recall/conditional-field/index/explanation.js";
import { projectAcceptingIndex } from "../../../../recall/conditional-field/index/project-accepting-index.js";
import { productStateNodeId } from "../../../../recall/conditional-field/reference/bind-max-min.js";
import { defaultBudget, defaultView, productKey, SNAPSHOT_ID } from "../reference/deployment.fixture.js";
import {
  enumerateSimplePaths,
  type OracleEdge,
  type OracleSeed
} from "../../conditional-field-oracle/enumerate-simple-paths.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const VALIDITY = { kind: "open" as const, valid_from: "2026-01-01T00:00:00.000Z" };

describe("shared dependencies, witnesses, and SCC withdrawal", () => {
  it("evaluates a layered diamond from shared rules without enumerating all paths", () => {
    const layers = 8;
    const diamond = layeredDiamond(layers);
    const pathCount = 2 ** layers;
    expect(pathCount).toBeGreaterThan(diamond.transitions.length);
    const state = fieldOf(diamond.seeds, diamond.transitions);
    const grounded = groundedOutputDerivations({
      ...state,
      allowance: 10_000
    });
    expect(grounded.complete).toBe(true);
    expect(grounded.retained_rule_references).toBe(diamond.seeds.length + diamond.transitions.length);
    expect(grounded.retained_rule_references).toBeLessThan(pathCount);
    expect(grounded.work).toBeLessThan(pathCount);
    expect(grounded.derivations.length).toBeLessThan(pathCount);
    const sink = diamond.sinks[0]!;
    const sinkKey = productStateNodeId(sink);
    expect(gradeOf(state, sink)).toBe(900);
    const rootIds = grounded.roots[sinkKey] ?? [];
    expect(rootIds).toHaveLength(1);
    const witness = recoverExplanationForest(rootIds, grounded.derivations);
    expect(witness.length).toBeGreaterThan(0);
    expect(witness.length).toBeLessThan(pathCount);
    const small = layeredDiamond(2);
    const enumerated = enumerateSimplePaths(
      small.seeds.map(toOracleSeed),
      small.transitions.map(toOracleEdge)
    );
    expect(enumerated.kind).toBe("enumerated");
    const smallState = fieldOf(small.seeds, small.transitions);
    for (const node of [small.seed, ...small.sinks]) {
      expect(gradeOf(smallState, node)).toBe(enumerated.values.get(productStateNodeId(node)));
    }
  });

  it("withdraws a high-grade source and keeps the lower alternative", () => {
    const seed = productKey("s");
    const end = productKey("end");
    const state = fieldOf(
      [activation(seed, 1000)],
      [edge(seed, end, "strong", 900), edge(seed, end, "weak", 200)]
    );
    expect(gradeOf(state, end)).toBe(900);
    const after = withdrawDerivationLeaves(state, "strong");
    expect(gradeOf(after, end)).toBe(200);
    expect(after.transitions.map((row) => row.relation_kind)).toEqual(["weak"]);
  });

  it("revokes equal-grade distinct sources independently", () => {
    const seed = productKey("s");
    const end = productKey("end");
    const state = fieldOf(
      [activation(seed, 1000)],
      [edge(seed, end, "src_a", 800), edge(seed, end, "src_b", 800)]
    );
    expect(gradeOf(state, end)).toBe(800);
    const afterA = withdrawDerivationLeaves(state, "src_a");
    expect(gradeOf(afterA, end)).toBe(800);
    expect(afterA.transitions.map((row) => row.relation_kind)).toEqual(["src_b"]);
    const afterB = withdrawDerivationLeaves(state, "src_b");
    expect(gradeOf(afterB, end)).toBe(800);
    expect(afterB.transitions.map((row) => row.relation_kind)).toEqual(["src_a"]);
    expect(gradeOf(withdrawDerivationLeaves(afterA, "src_b"), end)).toBe(0);
  });

  it("clears SCC support after removing the sole cycle seed", () => {
    const a = productKey("a");
    const b = productKey("b");
    const support: SupportRecord[] = [supportRecord("a", [
      witnessOf("cycle-a", ["a"], 1)
    ])];
    const state = createConditionalField({
      interpretation: interpretation(),
      budget: defaultBudget(),
      seeds: [activation(a, 1000)],
      transitions: [edge(a, b, "ab", 900), edge(b, a, "ba", 900)],
      support
    });
    expect(gradeOf(state, a)).toBe(1000);
    expect(gradeOf(state, b)).toBe(900);
    expect(state.support).toHaveLength(1);
    const after = withdrawDerivationLeaves(state, seedDerivationIdentity(productStateNodeId(a)));
    expect(after.seeds).toHaveLength(0);
    expect(activationOf(after, a)).toEqual({ kind: "unreachable" });
    expect(activationOf(after, b)).toEqual({ kind: "unreachable" });
    if (after.binding.kind === "bound") {
      expect(after.binding.values.has(productStateNodeId(a))).toBe(false);
      expect(after.binding.values.has(productStateNodeId(b))).toBe(false);
    }
    expect(after.support).toEqual([]);
  });

  it("treats same object with different hypothesis, binding, and time as distinct products", () => {
    const left = memoryProductStateKey({
      workspace_id: "ws",
      object_id: "obj",
      source_revision: "rev",
      program_state: "accepting",
      hypothesis_id: "h0",
      binding_context: "bind-0",
      time_state: "t0"
    });
    const right = memoryProductStateKey({
      workspace_id: "ws",
      object_id: "obj",
      source_revision: "rev",
      program_state: "accepting",
      hypothesis_id: "h1",
      binding_context: "bind-1",
      time_state: "t1"
    });
    expect(productSubjectId(left)).toBe(productSubjectId(right));
    expect(productStateNodeId(left)).not.toBe(productStateNodeId(right));
    const state = fieldOf([activation(left, 900), activation(right, 900)], []);
    expect(state.seeds).toHaveLength(2);
    const grounded = groundedOutputDerivations({ ...state, allowance: 100 });
    expect(Object.keys(grounded.roots)).toHaveLength(2);
    const originRoot = {
      workspace_id: "ws",
      root_kind: "source_record" as const,
      root_id: "rec-1",
      source_version: "v1",
      content_digest: DIGEST,
      evidence_object_id: null,
      program_state: "accepting",
      hypothesis_id: "h0",
      binding_context: "default",
      time_state: "as_of"
    };
    const originA = sourceProductStateKey({
      ...originRoot,
      span: {
        content_start: 0,
        content_end: 8,
        retained_extent: "excerpt",
        content_complete: false,
        original_complete: true
      }
    });
    const originAChunk = sourceProductStateKey({
      ...originRoot,
      span: {
        content_start: 8,
        content_end: 16,
        retained_extent: "excerpt",
        content_complete: true,
        original_complete: true
      }
    });
    const originB = sourceProductStateKey({
      ...originRoot,
      root_id: "rec-2"
    });
    expect(sharedProductIdentity(originA)).toBe(sharedProductIdentity(originAChunk));
    expect(sharedProductIdentity(originA)).not.toBe(sharedProductIdentity(originB));
    const index = projectAcceptingIndex({
      snapshot: {
        schema_version: 1,
        snapshot_id: SNAPSHOT_ID,
        query_id: "cp06",
        seeds: [],
        values: [
          fieldValueOf(left, 900),
          fieldValueOf(right, 900)
        ],
        retained_transitions: [edge(productKey("src"), left, "facet_rel", 900)],
        facets: [
          ...samePathPair(left),
          ...samePathPair(right)
        ]
      },
      view: { ...defaultView(), facet_mode: "independent", threshold_milligrades: 800 },
      query_id: "cp06",
      snapshot_id: SNAPSHOT_ID,
      result_version: "v1",
      budget: defaultBudget(),
      relation_facet_modes: new Map([["facet_rel", "same_path"]])
    });
    expect(index.entries).toHaveLength(1);
    expect(index.entries[0]?.hypothesis_id).toBe("h1");
    expect(index.entries[0]?.output_binding).toBe("bind-1");
    expect(index.entries[0]?.time_state).toBe("t1");
  });

  it("treats reversed serial order as a different instance", () => {
    const a = leafDerivation({ derivation_id: "a", observation_id: "a", leaf_id: "a" });
    const b = leafDerivation({ derivation_id: "b", observation_id: "b", leaf_id: "b" });
    const ab = joinDerivation("serial", [a, b]);
    const ba = joinDerivation("serial", [b, a]);
    expect(ab.derivation_id).not.toBe(ba.derivation_id);
    const forest = new Map([[a.derivation_id, a], [b.derivation_id, b], [ab.derivation_id, ab], [ba.derivation_id, ba]]);
    expect(withdrawDerivation(forest, ab.derivation_id, "a")).toBeUndefined();
    expect(withdrawDerivation(forest, ba.derivation_id, "a")).toBeUndefined();
    expect(withdrawDerivation(forest, ab.derivation_id, "b")).toBeUndefined();
    const seed = productKey("s");
    const mid = productKey("m");
    const end = productKey("end");
    const forward = fieldOf(
      [activation(seed, 1000)],
      [edge(seed, mid, "first", 900), edge(mid, end, "second", 800)]
    );
    const reversed = fieldOf(
      [activation(seed, 1000)],
      [edge(seed, mid, "second", 800), edge(mid, end, "first", 900)]
    );
    expect(forward.transitions.map((row) => row.relation_kind)).not.toEqual(
      reversed.transitions.map((row) => row.relation_kind)
    );
    expect(transitionKey(forward.transitions.at(0)!)).not.toBe(transitionKey(reversed.transitions.at(0)!));
  });

  it("does not coordinate-max (900,200) and (200,900) under same-path conjunction", () => {
    const left: FacetVector = { schema_version: 1, path_id: "p-left", coordinates: [900, 200] };
    const right: FacetVector = { schema_version: 1, path_id: "p-right", coordinates: [200, 900] };
    expect(samePathAccepts([left], 150)).toBe(true);
    expect(samePathAccepts([right], 150)).toBe(true);
    expect(samePathAccepts([left, right], 800)).toBe(false);
    expect(samePathAccepts([{ schema_version: 1, path_id: "merged", coordinates: [900, 900] }], 800)).toBe(true);
    const state = createConditionalField({
      interpretation: interpretation(),
      budget: defaultBudget(),
      seeds: [activation(productKey("c"), 900)],
      facets: [left, right]
    });
    expect(state.facets).toHaveLength(2);
    expect(state.facets.map((row) => row.coordinates)).toEqual([[900, 200], [200, 900]]);
  });

  it("keeps membership when every explanation exceeds the page budget", () => {
    const value = fieldValueOf(productKey("r"), 850);
    const key = productStateNodeId(value.state);
    const root = leafDerivation({
      derivation_id: "expensive-root",
      observation_id: "r",
      leaf_id: "r",
      witness_id: "too-big",
      association_milligrades: 850
    });
    const index = projectAcceptingIndex({
      snapshot: {
        schema_version: 1,
        snapshot_id: SNAPSHOT_ID,
        query_id: "cp06",
        seeds: [activation(value.state, 850)],
        values: [value],
        retained_transitions: [],
        facets: []
      },
      view: defaultView(),
      query_id: "cp06",
      snapshot_id: SNAPSHOT_ID,
      result_version: "v1",
      budget: defaultBudget({ page_budget: 50 }),
      derivations: [root],
      output_derivations: { [key]: [root.derivation_id] },
      support: [supportRecord("r", [witnessOf("too-big", ["r"], 400)])]
    });
    expect(index.entries).toHaveLength(1);
    expect(index.entries[0]?.object_id).toBe("r");
    expect(index.entries[0]?.association_milligrades).toBe(850);
    expect(index.entries[0]?.explanation_ids).toEqual([]);
    expect(index.completeness.logical_index).not.toBe("resource_rejected");
    expect(index.completeness.payload).not.toBe("complete");
  });

  it("clears SCC-derived support on cap decrease and recomputes from surviving inputs", () => {
    const src = productKey("src");
    const left = productKey("obj", "h0", "bind-0");
    const right = productKey("obj", "h1", "bind-1");
    const leftId = productStateNodeId(left);
    const rightId = productStateNodeId(right);
    const state = createConditionalField({
      interpretation: interpretation(),
      budget: defaultBudget(),
      seeds: [activation(src, 1000)],
      transitions: [{ ...edge(src, left, "rel", 900), instance_id: "left-assertion", revision_id: "v1" }, edge(src, right, "rel", 900)],
      support: [
        supportRecord(leftId, [witnessOf("w-left", [leftId], 1)]),
        supportRecord(rightId, [witnessOf("w-right", [rightId], 1)])
      ]
    });
    expect(gradeOf(state, left)).toBe(900);
    expect(gradeOf(state, right)).toBe(900);
    expect(state.support.map((row) => row.proposition_id).sort()).toEqual([leftId, rightId].sort());
    const decreased = applyObserverPage(state, {
      page: adjacencyPage(),
      effects: [{ observation_id: "rel-cap-down", transition: { ...edge(src, left, "rel", 200), instance_id: "left-assertion", revision_id: "v2" } }]
    });
    expect(gradeOf(decreased, left)).toBe(200);
    expect(gradeOf(decreased, right)).toBe(900);
    expect(gradeOf(decreased, src)).toBe(1000);
    expect(decreased.support.map((row) => row.proposition_id)).toEqual([rightId]);
    expect(decreased.transitions.filter((row) => productStateNodeId(row.to) === leftId)
      .map((row) => row.strength_milligrades)).toEqual([200]);
  });

  it("drops SCC support when a rule becomes inapplicable without minting unseeded zeros", () => {
    const a = productKey("a");
    const b = productKey("b");
    const state = createConditionalField({
      interpretation: interpretation(),
      budget: defaultBudget(),
      seeds: [activation(a, 1000)],
      transitions: [{ ...edge(a, b, "ab", 900), instance_id: "ab-assertion", revision_id: "v1" }, edge(b, a, "ba", 900)],
      support: [
        supportRecord("a", [witnessOf("cycle-a", ["a"], 1)]),
        supportRecord("b", [witnessOf("cycle-b", ["b"], 1)])
      ]
    });
    expect(gradeOf(state, b)).toBe(900);
    const revoked = applyObserverPage(state, {
      page: adjacencyPage(),
      effects: [{ observation_id: "ab-denied", transition: { ...edge(a, b, "ab", 900, false), instance_id: "ab-assertion", revision_id: "v2" } }]
    });
    expect(gradeOf(revoked, a)).toBe(1000);
    expect(activationOf(revoked, b)).toEqual({ kind: "unreachable" });
    if (revoked.binding.kind === "bound") {
      expect(revoked.binding.values.has(productStateNodeId(b))).toBe(false);
    }
    expect(revoked.support).toEqual([]);
    expect(revoked.transitions.some((row) => row.relation_kind === "ab" && row.applicable)).toBe(false);
  });
});

function layeredDiamond(layers: number): {
  readonly seed: ProductStateKey;
  readonly seeds: ReturnType<typeof activation>[];
  readonly transitions: Transition[];
  readonly sinks: ProductStateKey[];
} {
  const seed = productKey("s");
  const transitions: Transition[] = [];
  let previous: ProductStateKey[] = [seed];
  for (let layer = 1; layer <= layers; layer += 1) {
    const left = productKey(`a${layer}`);
    const right = productKey(`b${layer}`);
    for (const from of previous) {
      transitions.push(edge(from, left, `to-a${layer}-from-${productSubjectId(from)}`, 900));
      transitions.push(edge(from, right, `to-b${layer}-from-${productSubjectId(from)}`, 900));
    }
    previous = [left, right];
  }
  return { seed, seeds: [activation(seed, 1000)], transitions, sinks: previous };
}

function fieldOf(
  seeds: ReturnType<typeof activation>[],
  transitions: readonly Transition[]
) {
  return createConditionalField({
    interpretation: interpretation(),
    budget: defaultBudget(),
    seeds,
    transitions
  });
}

function interpretation(): QueryInterpretation {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    query_id: "cp06",
    status: "resolved",
    snapshot_id: SNAPSHOT_ID,
    program: { schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, kind: "epsilon" },
    view: defaultView(),
    holes: [],
    hypotheses: []
  };
}

function activation(state: ProductStateKey, milligrades: number) {
  return { schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, state, milligrades };
}

function edge(
  from: ProductStateKey,
  to: ProductStateKey,
  relationKind: string,
  strength: number,
  applicable = true
): Transition {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    from,
    to,
    relation_kind: relationKind,
    strength_milligrades: strength,
    validity: VALIDITY,
    applicable
  };
}

function adjacencyPage(): ObserverPage {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    query_id: "cp06",
    snapshot_id: SNAPSHOT_ID,
    cursor: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      cursor_id: "adjacency-cursor",
      snapshot_id: SNAPSHOT_ID,
      query_id: "cp06",
      region_id: "adjacency",
      position: null,
      committed_through: null
    },
    observations: [],
    outcome: { schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, status: "open" },
    open_regions: [{
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      region_id: "adjacency",
      kind: "adjacency",
      status: "open"
    }]
  };
}

function gradeOf(state: ReturnType<typeof createConditionalField>, product: ProductStateKey): number {
  if (state.binding.kind !== "bound") return 0;
  const key = productStateNodeId(product);
  return state.binding.snapshot.values.find((row) => productStateNodeId(row.state) === key)
    ?.milligrades ?? 0;
}

function activationOf(
  state: ReturnType<typeof createConditionalField>,
  product: ProductStateKey
) {
  if (state.binding.kind !== "bound") return undefined;
  const key = productStateNodeId(product);
  return state.binding.snapshot.values.find((row) => productStateNodeId(row.state) === key)?.activation;
}

function fieldValueOf(state: ProductStateKey, milligrades: number) {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    state,
    milligrades,
    accepting: true,
    activation: { kind: "reachable" as const, milligrades }
  };
}

function samePathPair(state: ProductStateKey): FacetVector[] {
  return [
    { schema_version: 1, path_id: composedFacetPathId(state, "left"), coordinates: [900, 200] },
    { schema_version: 1, path_id: composedFacetPathId(state, "right"), coordinates: [200, 900] }
  ];
}

function supportRecord(propositionId: string, witnesses: readonly Witness[]): SupportRecord {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    proposition_id: propositionId,
    claim: "supported",
    witnesses
  };
}

function witnessOf(id: string, premises: readonly string[], cost: number): Witness {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    witness_id: id,
    premises,
    cost,
    complete: true
  };
}

function toOracleSeed(seed: ReturnType<typeof activation>): OracleSeed {
  return { state: seed.state, milligrades: seed.milligrades };
}

function toOracleEdge(transition: Transition): OracleEdge {
  return {
    from: transition.from,
    to: transition.to,
    relation_kind: transition.relation_kind,
    strength_milligrades: transition.strength_milligrades,
    applicable: transition.applicable,
    cost: 1
  };
}
