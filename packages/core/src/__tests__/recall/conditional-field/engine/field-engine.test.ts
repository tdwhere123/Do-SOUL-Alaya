import { describe, expect, it } from "vitest";
import {
  ASSOCIATION_DOMAIN_ID,
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  MILLIGRADE_TOP,
  productSubjectId,
  type CoverageRegion,
  type FacetVector,
  type ObserverPage,
  type ObserverStatus,
  type ProductStateKey,
  type ProjectedCap,
  type QueryInterpretation,
  type SeedActivation,
  type Transition,
  type TypedObservation
} from "@do-soul/alaya-protocol";
import {
  applyEvidenceEffect,
  applyObserverPage,
  createConditionalField,
  projectFieldDelta,
  proposeFieldWork
} from "../../../../recall/conditional-field/engine/field-engine.js";
import { bindEngineState } from "../../../../recall/conditional-field/engine/field-update.js";
import { productStateNodeId } from "../../../../recall/conditional-field/reference/bind-max-min.js";
import {
  samePathAccepts,
  serialMin,
  tryCompleteHyperedge
} from "../../../../recall/conditional-field/engine/path-composition.js";
import { observeField, seedEffects } from "../../../../recall/runtime/conditional-field-observe.js";
import { type ObserverReaders } from "../../../../recall/conditional-field/observers/observe.js";
import {
  QUERY_ID,
  SNAPSHOT_ID,
  defaultBudget,
  defaultView,
  deploymentProgram,
  deploymentSeeds,
  deploymentTransitions,
  productKey
} from "../reference/deployment.fixture.js";

const VALIDITY = { kind: "open" as const, valid_from: "2026-01-01T00:00:00.000Z" };
const OTHER_SNAPSHOT = `sha256:${"d".repeat(64)}`;

describe("conditional-field engine", () => {
  it("binds the deployment graph at milligrade min/max without common cause", () => {
    const state = createDeploymentField();
    expect(valueOf(state, "c")).toBe(1000);
    expect(valueOf(state, "h")).toBe(1000);
    expect(valueOf(state, "r")).toBe(1000);
    expect(valueOf(state, "l")).toBe(1000);
    expect(valueOf(state, "s")).toBe(1000);
    expect(valueOf(state, "u")).toBe(0);
    const withClaim = applyEvidenceEffect(state, {
      support: [{
        schema_version: 1,
        proposition_id: "common-cause",
        claim: "unknown",
        witnesses: []
      }],
      claims: new Map([["h", "unknown"], ["c", "unknown"]])
    });
    expect(withClaim.claims.get("h")).toBe("unknown");
    expect(valueOf(withClaim, "h")).toBe(1000);
    expect(withClaim.support[0]?.claim).toBe("unknown");
    expect(withClaim.binding.kind).toBe("bound");
    if (withClaim.binding.kind !== "bound") return;
    expect(withClaim.binding.snapshot.retained_transitions.some((row) => productSubjectId(row.to) === "u"))
      .toBe(false);
    const unrelated = withClaim.binding.snapshot.values.find((row) => productSubjectId(row.state) === "u");
    expect(unrelated?.activation).toEqual({ kind: "unreachable" });
    expect(unrelated?.milligrades).toBeUndefined();
  });

  it("keeps long homogeneous chains and shared-service fan-out without hop attenuation", () => {
    const hops: Transition[] = [];
    for (let index = 0; index < 20; index += 1) {
      hops.push(edge(productKey(`n${index}`), productKey(`n${index + 1}`), "chain", 900, true));
    }
    const histories: Transition[] = [];
    for (let index = 0; index < 8; index += 1) {
      histories.push(edge(productKey("s"), productKey(`h${index}`), "service_history", 550, true));
    }
    const state = createConditionalField({
      interpretation: interpretation(),
      budget: defaultBudget(),
      seeds: [seed(productKey("n0"), 900), seed(productKey("s"), 900)],
      transitions: [...hops, ...histories]
    });
    expect(serialMin(Array.from({ length: 21 }, () => 900))).toBe(900);
    expect(valueOf(state, "n20")).toBe(900);
    for (let index = 0; index < 8; index += 1) {
      expect(valueOf(state, `h${index}`)).toBe(550);
    }
  });

  it("completes hyperedge AND only under one binding and all premises", () => {
    const from = productKey("r");
    const to = productKey("c");
    const completion = {
      from,
      to,
      relation_kind: "and_config",
      strength_milligrades: 850,
      validity: VALIDITY
    };
    const compatible = [
      { hypothesis_id: "h0", binding_context: "default", time_state: "as_of", present: true },
      { hypothesis_id: "h0", binding_context: "default", time_state: "as_of", present: true }
    ];
    expect(tryCompleteHyperedge(compatible, completion)?.applicable).toBe(true);
    expect(tryCompleteHyperedge([
      { hypothesis_id: "h0", binding_context: "bind-a", time_state: "as_of", present: true },
      { hypothesis_id: "h0", binding_context: "bind-b", time_state: "as_of", present: true }
    ], completion)).toBeUndefined();
    expect(tryCompleteHyperedge([
      { hypothesis_id: "h0", binding_context: "default", time_state: "as_of", present: true },
      { hypothesis_id: "h0", binding_context: "default", time_state: "as_of", present: false }
    ], completion)).toBeUndefined();
    const incomplete = applyObserverPage(createEmptyField(), {
      page: page({ region_id: "adjacency" }),
      effects: [{
        observation_id: "and-partial",
        hyperedge_premises: compatible.map((premise, index) => ({
          ...premise,
          present: index === 0
        })),
        hyperedge: completion
      }]
    });
    expect(incomplete.transitions).toHaveLength(0);
    expect(valueOf(incomplete, "c")).toBe(0);
    const complete = applyObserverPage(createEmptyField(), {
      page: page({ region_id: "adjacency" }),
      effects: [{
        observation_id: "and-full",
        seed: seed(from, 1000),
        hyperedge_premises: compatible,
        hyperedge: completion
      }]
    });
    expect(complete.transitions).toHaveLength(1);
    expect(valueOf(complete, "c")).toBe(850);
  });

  it("keeps residuals open after known-graph fixed point and lets a late seed change values", () => {
    const state = createDeploymentField();
    expect(state.closure.propagation).toBe("fixed_point");
    expect(state.closure.observation).toBe("open");
    expect(state.closure.requested_index).toBe("open");
    expect([...openKinds(state.residuals)].sort()).toEqual(["adjacency", "binding", "guard", "seed"]);
    expect(projectFieldDelta(state).accepted_states.find((row) => productSubjectId(row.state) === "x"))
      .toBeUndefined();
    const late = applyObserverPage(state, {
      page: page({
        region_id: "seed",
        observations: [observation("late-x", "x", 1000)],
        status: "open",
        open_regions: [openRegion("seed", "seed")]
      }),
      effects: [{
        observation_id: "late-x",
        seed: seed(productKey("x"), 1000),
        transition: edge(productKey("r"), productKey("x"), "late_relation", 1000, true)
      }]
    });
    expect(late.closure.propagation).toBe("fixed_point");
    expect(late.closure.requested_index).toBe("open");
    expect(valueOf(late, "x")).toBe(1000);
    expect(openKinds(late.residuals)).toContain("seed");
    expect(openKinds(late.residuals)).toContain("adjacency");
  });

  it("retains same-path vectors as joint witnesses and does not coordinate-max them", () => {
    const vectors: FacetVector[] = [
      { schema_version: 1, path_id: "p1", coordinates: [900, 200] },
      { schema_version: 1, path_id: "p2", coordinates: [200, 900] }
    ];
    expect(samePathAccepts(vectors, 800)).toBe(false);
    const state = createConditionalField({
      interpretation: interpretation(),
      budget: defaultBudget(),
      seeds: [seed(productKey("c"), 900)],
      facets: vectors
    });
    expect(state.facets).toHaveLength(2);
    expect(state.facets.at(0)?.coordinates).toEqual([900, 200]);
    expect(state.facets.at(1)?.coordinates).toEqual([200, 900]);
  });

  it("serves finite lower-priority regions without consuming the finalization reserve", () => {
    const state = createConditionalField({
      interpretation: interpretation(),
      budget: defaultBudget({ work_units: 100, finalization_reserve: 20, min_envelope: 10 }),
      extra_work_regions: [
        { id: "high-refine", priority: 2, finite: false, work: 10_000 },
        { id: "low-finite", priority: 1, finite: true, work: 1 }
      ]
    });
    const proposed = proposeFieldWork(state);
    expect(proposed.actions.map((action) => action.region_id)).toContain("seed");
    expect(proposed.remainingReserve).toBe(state.remaining_reserve);
    expect(proposed.starvedFinite).toBe(false);
  });

  it("refuses to retain chain identities that do not fit remaining_memory_bytes", () => {
    const hops: Transition[] = [];
    for (let index = 0; index < 8; index += 1) {
      hops.push(edge(productKey(`n${index}`), productKey(`n${index + 1}`), "chain", 900, true));
    }
    const state = createConditionalField({
      interpretation: interpretation(),
      budget: defaultBudget({ memory_bytes: 300, work_units: 50, finalization_reserve: 5, min_envelope: 1 }),
      seeds: [seed(productKey("n0"), 900)],
      transitions: hops
    });
    expect(state.memory_exhausted).toBe(true);
    expect(state.identity_spool).toHaveLength(0);
    expect(state.seen_identities.length).toBeLessThan(9);
    expect(state.closure.requested_index).not.toBe("complete");
    expect(proposeFieldWork(state).actions).toHaveLength(0);
  });

  it("does not let duplicate observations manufacture association strength", () => {
    const first = applyObserverPage(createEmptyField(), {
      page: page({
        observations: [observation("r-1", "r", 850)]
      }),
      effects: [{ observation_id: "r-1", seed: seed(productKey("r"), 850) }]
    });
    const duplicate = applyObserverPage(first, {
      page: page({
        observations: [observation("r-1", "r", 850), observation("r-2", "r", 850)]
      }),
      effects: [{ observation_id: "r-2", seed: seed(productKey("r"), 850) }]
    });
    expect(valueOf(duplicate, "r")).toBe(850);
    expect(duplicate.observations).toHaveLength(2);
  });

  it("spends remaining_reserve on the solver after exploration is exhausted", () => {
    const state = createConditionalField({
      interpretation: interpretation(),
      budget: defaultBudget({ work_units: 8, finalization_reserve: 2, min_envelope: 1 }),
      seeds: deploymentSeeds(),
      transitions: deploymentTransitions()
    });
    expect(state.binding.kind).toBe("bound");
    expect(valueOf(state, "r")).toBe(1000);
    expect(state.remaining_reserve).toBeLessThan(2);
    expect(state.remaining_work.some((item) => item.kind === "state_create" || item.kind === "relaxation")
      || state.remaining_reserve < 2).toBe(true);
  });

  it("treats scalar fixed point as a projection, not explanation coverage", () => {
    const state = createDeploymentField();
    expect(state.closure.propagation).toBe("fixed_point");
    const openSupport = applyEvidenceEffect(state, {
      support: state.support,
      work_status: "open"
    });
    const kinds = ["seed", "adjacency", "guard", "binding"] as const;
    let exhausted = openSupport;
    for (const kind of kinds) {
      exhausted = applyObserverPage(exhausted, {
        page: page({
          region_id: kind,
          status: "exhausted",
          open_regions: [{ schema_version: 1, region_id: kind, kind, status: "exhausted" }]
        })
      });
    }
    expect(exhausted.closure.propagation).toBe("fixed_point");
    expect(exhausted.support_work_status).toBe("open");
    expect(exhausted.closure.observation).toBe("exhausted");
    expect(exhausted.closure.requested_index).not.toBe("complete");
  });

  it("keeps a cheaper complete alternative derivation after a stronger path wins", () => {
    const cheap = {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      derivation_id: "or-cheap",
      kind: "or" as const,
      children: ["cheap"],
      observation_ids: ["cheap"],
      leaf_ids: ["cheap"],
      source_revisions: ["rev-cheap"],
      witness_id: "cheap"
    };
    const expensive = {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      derivation_id: "or-expensive",
      kind: "or" as const,
      children: ["expensive"],
      observation_ids: ["expensive"],
      leaf_ids: ["expensive"],
      source_revisions: ["rev-expensive"],
      witness_id: "expensive"
    };
    const state = applyObserverPage(createEmptyField(), {
      page: page({ region_id: "adjacency" }),
      effects: [
        {
          observation_id: "cheap",
          seed: seed(productKey("r"), 1000),
          transition: edge(productKey("r"), productKey("c"), "cheap_path", 400, true),
          derivation: cheap,
          derivations: [cheap]
        },
        {
          observation_id: "expensive",
          transition: edge(productKey("r"), productKey("c"), "expensive_path", 900, true),
          derivation: expensive,
          derivations: [expensive]
        }
      ]
    });
    expect(valueOf(state, "c")).toBe(900);
    expect(state.derivations.map((row) => row.derivation_id).sort()).toEqual([
      "or-cheap",
      "or-expensive"
    ]);
    expect(state.transitions).toHaveLength(2);
  });

  it("starts a new epoch on snapshot revision instead of monotone refinement", () => {
    const state = createDeploymentField();
    const revised = applyObserverPage(state, {
      page: page({
        snapshot_id: OTHER_SNAPSHOT,
        observations: [observation("r-new", "r", 100)]
      })
    });
    expect(revised.epoch).toBe(state.epoch + 1);
    expect(revised.snapshot_id).toBe(OTHER_SNAPSHOT);
    expect(revised.closure.requested_index).toBe("invalidated");
    expect(valueOf(revised, "c")).toBe(0);
  });

  it("charges two solver runs when exploration can pay both bindings", () => {
    const budget = defaultBudget({ work_units: 20, finalization_reserve: 2, min_envelope: 1 });
    const state = createConditionalField({
      interpretation: interpretation(),
      budget,
      seeds: [seed(productKey("r"), 1000)],
      transitions: []
    });
    const spentExploration = (budget.work_units - budget.finalization_reserve) - state.remaining_exploration;
    const spentReserve = budget.finalization_reserve - state.remaining_reserve;
    expect(state.binding.kind).toBe("bound");
    if (state.binding.kind !== "bound") return;
    expect(state.binding.solver_runs).toBeGreaterThanOrEqual(2);
    expect(state.binding.solver_steps).toBeGreaterThanOrEqual(2);
    expect(spentExploration + spentReserve).toBeGreaterThan(state.binding.solver_runs - 1);
    expect(spentExploration + spentReserve).toBeGreaterThanOrEqual(3);
  });

  it("keeps proven values and residual relaxation when a second solve cannot be paid", () => {
    const state = createConditionalField({
      interpretation: interpretation(),
      budget: defaultBudget({ work_units: 2, finalization_reserve: 0, min_envelope: 0 }),
      seeds: [seed(productKey("r"), 1000)],
      transitions: []
    });
    expect(valueOf(state, "r")).toBe(1000);
    expect(state.binding.kind).toBe("bound");
    if (state.binding.kind !== "bound") return;
    expect(state.binding.solver_runs).toBe(1);
    expect(state.remaining_work.some((row) => row.kind === "relaxation")).toBe(true);
    expect(state.closure.propagation).toBe("open");
  });

  it("pauses mid-solve and resumes from the remaining worklist", () => {
    const hops: Transition[] = [];
    for (let index = 0; index < 8; index += 1) {
      hops.push(edge(productKey(`n${index}`), productKey(`n${index + 1}`), "chain", 900, true));
    }
    const paused = createConditionalField({
      interpretation: interpretation(),
      budget: defaultBudget({ work_units: 11, finalization_reserve: 0, min_envelope: 0 }),
      seeds: [seed(productKey("n0"), 900)],
      transitions: hops
    });
    expect(paused.binding.kind).toBe("bound");
    if (paused.binding.kind !== "bound") return;
    expect(paused.binding.solver_complete).toBe(false);
    expect(paused.binding.remaining_worklist.length).toBeGreaterThan(0);
    expect(valueOf(paused, "n0")).toBe(900);
    expect(activationOf(paused, "n8")).toEqual({ kind: "unreachable" });
    expect(paused.remaining_work.some((row) => row.kind === "relaxation")).toBe(true);
    const { binding, closure: _closure, ...rest } = paused;
    const resumed = bindEngineState({
      ...rest,
      remaining_exploration: 100,
      proven_binding: binding
    });
    expect(valueOf(resumed, "n8")).toBe(900);
    expect(resumed.binding.kind).toBe("bound");
    if (resumed.binding.kind !== "bound") return;
    expect(resumed.binding.solver_complete).toBe(true);
    expect(resumed.remaining_work.some((row) => row.kind === "relaxation")).toBe(false);
  });

  it("resumes the guaranteed worklist without cold-starting it as the possible system", () => {
    const hops: Transition[] = [];
    for (let index = 0; index < 8; index += 1) {
      hops.push(edge(productKey(`n${index}`), productKey(`n${index + 1}`), "chain", 900, true));
    }
    const paused = createConditionalField({
      interpretation: interpretation(),
      budget: defaultBudget({ work_units: 39, finalization_reserve: 0, min_envelope: 0 }),
      seeds: [seed(productKey("n0"), 900)],
      transitions: hops
    });
    expect(paused.binding.kind).toBe("bound");
    if (paused.binding.kind !== "bound") return;
    expect(paused.binding.possible_complete).toBe(true);
    expect(paused.binding.guaranteed_complete).toBe(false);
    expect(paused.binding.solver_complete).toBe(false);
    expect(valueOf(paused, "n8")).toBe(900);
    expect(paused.binding.guaranteed_values?.get(productStateNodeId(productKey("n0")))).toBe(900);
    expect(paused.binding.guaranteed_values?.has(productStateNodeId(productKey("n8")))).toBe(false);
    expect((paused.binding.guaranteed_worklist ?? paused.binding.remaining_worklist).length).toBeGreaterThan(0);
    const { binding, closure: _closure, ...rest } = paused;
    const stepped = bindEngineState({
      ...rest,
      remaining_exploration: 1,
      remaining_reserve: 0,
      proven_binding: binding
    });
    expect(stepped.binding.kind).toBe("bound");
    if (stepped.binding.kind !== "bound") return;
    expect(stepped.binding.possible_complete).toBe(true);
    expect(stepped.binding.guaranteed_complete).toBe(false);
    expect(stepped.binding.guaranteed_values?.has(productStateNodeId(productKey("n2")))).toBe(true);
    const resumed = bindEngineState({
      ...rest,
      remaining_exploration: 100,
      remaining_work: [],
      proven_binding: stepped.binding
    });
    expect(resumed.binding.kind).toBe("bound");
    if (resumed.binding.kind !== "bound") return;
    expect(resumed.binding.solver_complete).toBe(true);
    expect(resumed.binding.guaranteed_values?.get(productStateNodeId(productKey("n8")))).toBe(900);
    expect(lowOf(resumed, "n8")).toBe(900);
  });

  it("does not activate a no-seed cycle", () => {
    const state = createConditionalField({
      interpretation: interpretation(),
      budget: defaultBudget(),
      seeds: [],
      transitions: [
        edge(productKey("a"), productKey("b"), "ab", 1000, true),
        edge(productKey("b"), productKey("a"), "ba", 900, true)
      ]
    });
    expect(activationOf(state, "a")).toEqual({ kind: "unreachable" });
    expect(activationOf(state, "b")).toEqual({ kind: "unreachable" });
    expect(valueOf(state, "a")).toBe(0);
  });

  it("does not put ungated seed effects on guaranteed_seeds", () => {
    const ungated = applyObserverPage(createEmptyField(), {
      page: page({ observations: [observation("r-ungated", "r", 850)] }),
      effects: [{ observation_id: "r-ungated", seed: seed(productKey("r"), 850) }]
    });
    expect(ungated.seeds).toHaveLength(1);
    expect(ungated.guaranteed_seeds).toHaveLength(0);
    expect(valueOf(ungated, "r")).toBe(850);

    const missing = applyObserverPage(createEmptyField(), {
      page: page({ observations: [observation("r-missing", "r", 850)] }),
      effects: [{
        observation_id: "r-missing",
        seed: seed(productKey("r"), 850),
        missing_measurement: true,
        projected_cap: projectedCap(850),
        admitted_seed: true
      }]
    });
    expect(missing.guaranteed_seeds).toHaveLength(0);

    const orphanCap = applyObserverPage(createEmptyField(), {
      page: page({ observations: [] }),
      effects: [{
        observation_id: "r-orphan",
        seed: seed(productKey("r"), 850),
        projected_cap: projectedCap(850)
      }]
    });
    expect(orphanCap.guaranteed_seeds).toHaveLength(0);

    const liveObservation = observation("seed:r", "r", 850);
    const liveEffects = seedEffects([liveObservation], interpretation(), "2026-01-01T00:00:00.000Z");
    expect(liveEffects.length).toBeGreaterThan(0);
    expect(liveEffects.every((effect) =>
      effect.admitted_seed === true
      && effect.projected_cap === undefined
      && effect.observation_id.startsWith(`${liveObservation.observation_id}:`)
    )).toBe(true);
    const admitted = applyObserverPage(createEmptyField(), {
      page: page({ observations: [liveObservation] }),
      effects: liveEffects
    });
    expect(admitted.guaranteed_seeds.length).toBeGreaterThan(0);
    expect(valueOf(admitted, "r")).toBe(850);
    expect(lowOf(admitted, "r")).toBe(850);

    const observed = observeField({
      ...interpretation(),
      program: { schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, kind: "epsilon" }
    }, {
      workspace_id: "ws",
      query_text: "needle",
      budget: defaultBudget(),
      as_of: "2026-01-01T00:00:00.000Z",
      authorized_scopes: null,
      readers: liveSeedReaders("r")
    });
    expect(observed.guaranteed_seeds.length).toBeGreaterThan(0);
    expect(observed.seeds.length).toBeGreaterThan(0);
    expect(observed.guaranteed_seeds.every((row) => productSubjectId(row.state) === "r")).toBe(true);

    const later = applyObserverPage(ungated, {
      page: page({ observations: [observation("r-later", "r", 850)] }),
      effects: seedEffects([observation("r-later", "r", 850)], interpretation(), "2026-01-01T00:00:00.000Z")
    });
    expect(ungated.binding.kind).toBe("bound");
    if (ungated.binding.kind === "bound") {
      expect(ungated.binding.solver_complete).toBe(true);
      expect(lowOf(ungated, "r")).toBe(0);
    }
    expect(later.guaranteed_seeds.length).toBeGreaterThan(0);
    expect(lowOf(later, "r")).toBe(850);
  });

  it("does not raise values on duplicate pages and converges across page widths", () => {
    const once = absorbEffects(seedChainEffects());
    const twice = absorbEffects([...seedChainEffects(), ...seedChainEffects()]);
    expect(valueOf(twice, "c")).toBe(valueOf(once, "c"));
    expect(valueOf(once, "c")).toBe(850);
    let paged = createEmptyField();
    for (const effect of seedChainEffects()) {
      paged = applyObserverPage(paged, {
        page: page({
          region_id: "adjacency",
          observations: effect.observation_id.startsWith("seed-")
            ? [observation(effect.observation_id, "r", 1000)]
            : []
        }),
        effects: [effect]
      });
    }
    expect(valueOf(paged, "c")).toBe(valueOf(once, "c"));
    expect(valueOf(paged, "l")).toBe(valueOf(once, "l"));
  });
});

function createDeploymentField() {
  return createConditionalField({
    interpretation: interpretation(),
    budget: defaultBudget(),
    roles: new Map([
      ["r", "requested"],
      ["l", "associated"],
      ["c", "associated"],
      ["s", "routing_only"],
      ["h", "associated"]
    ]),
    seeds: deploymentSeeds(),
    transitions: deploymentTransitions()
  });
}

function createEmptyField() {
  return createConditionalField({
    interpretation: interpretation(),
    budget: defaultBudget()
  });
}

function interpretation(): QueryInterpretation {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    query_id: QUERY_ID,
    status: "resolved",
    snapshot_id: SNAPSHOT_ID,
    program: deploymentProgram(),
    view: defaultView(),
    holes: [],
    hypotheses: []
  };
}

function seed(state: ProductStateKey, milligrades: number): SeedActivation {
  return { schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, state, milligrades };
}

function projectedCap(milligrades: number): ProjectedCap {
  return {
    status: "projected",
    domain_id: ASSOCIATION_DOMAIN_ID,
    transfer_id: "policy_defined",
    transfer_version: "v1",
    milligrades
  };
}

function seedChainEffects(): readonly {
  readonly observation_id: string;
  readonly seed?: SeedActivation;
  readonly transition?: Transition;
}[] {
  return [
    { observation_id: "seed-r", seed: seed(productKey("r"), 1000) },
    {
      observation_id: "edge-rl",
      transition: edge(productKey("r"), productKey("l"), "observed_log", 950, true)
    },
    {
      observation_id: "edge-lc",
      transition: edge(productKey("l"), productKey("c"), "config_via_log", 850, true)
    }
  ];
}

function absorbEffects(
  effects: readonly {
    readonly observation_id: string;
    readonly seed?: SeedActivation;
    readonly transition?: Transition;
  }[]
) {
  return applyObserverPage(createEmptyField(), {
    page: page({
      region_id: "adjacency",
      observations: [observation("seed-r", "r", 1000)]
    }),
    effects
  });
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
    validity: VALIDITY,
    applicable
  };
}

function observation(
  observationId: string,
  objectId: string,
  milligrades: number
): TypedObservation {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    observation_id: observationId,
    object_id: objectId,
    source_revision: "rev-1",
    workspace_id: "ws",
    applicability: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      kind: "query_predicate",
      verdict: "true",
      time_scope: "none"
    },
    association_milligrades: milligrades
  };
}

function page(input: {
  readonly region_id?: string;
  readonly observations?: readonly TypedObservation[];
  readonly status?: ObserverStatus;
  readonly open_regions?: readonly CoverageRegion[];
  readonly snapshot_id?: string;
  readonly query_id?: string;
} = {}): ObserverPage {
  const regionId = input.region_id ?? "seed";
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    query_id: input.query_id ?? QUERY_ID,
    snapshot_id: input.snapshot_id ?? SNAPSHOT_ID,
    cursor: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      cursor_id: `${regionId}-cursor`,
      snapshot_id: input.snapshot_id ?? SNAPSHOT_ID,
      query_id: input.query_id ?? QUERY_ID,
      region_id: regionId,
      position: null,
      committed_through: null
    },
    observations: input.observations ?? [],
    outcome: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      status: input.status ?? "open"
    },
    open_regions: input.open_regions ?? [openRegion(regionId, regionKind(regionId))]
  };
}

function openRegion(id: string, kind: CoverageRegion["kind"]): CoverageRegion {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    region_id: id,
    kind,
    status: "open",
    conservative_bound_milligrades: MILLIGRADE_TOP
  };
}

function regionKind(id: string): CoverageRegion["kind"] {
  if (id === "adjacency" || id === "guard" || id === "binding") return id;
  return "seed";
}

function openKinds(residuals: readonly CoverageRegion[]): readonly string[] {
  return residuals.filter((region) => region.status === "open").map((region) => region.kind);
}

function valueOf(
  state: ReturnType<typeof createConditionalField>,
  objectId: string
): number {
  if (state.binding.kind !== "bound") return 0;
  return state.binding.snapshot.values.find((row) => productSubjectId(row.state) === objectId)
    ?.milligrades ?? 0;
}

function lowOf(
  state: ReturnType<typeof createConditionalField>,
  objectId: string
): number | undefined {
  if (state.binding.kind !== "bound") return undefined;
  return state.binding.snapshot.values.find((row) => productSubjectId(row.state) === objectId)
    ?.low_milligrades;
}

function liveSeedReaders(objectId: string): ObserverReaders {
  return {
    lexical: () => ({
      ids: [objectId],
      nativeVisits: 1,
      nativeBytes: 1,
      rowsRead: 1,
      bytesRead: 1,
      truncated: false
    }),
    source: (input) => ({
      row: {
        object_id: input.objectId,
        sourceRevision: "rev",
        lifecycle_state: "active",
        scope_class: "project"
      },
      rowsRead: 1,
      bytesRead: 1,
      unavailable: false
    })
  };
}

function activationOf(
  state: ReturnType<typeof createConditionalField>,
  objectId: string
): { readonly kind: string; readonly milligrades?: number } | undefined {
  if (state.binding.kind !== "bound") return undefined;
  return state.binding.snapshot.values.find((row) => productSubjectId(row.state) === objectId)
    ?.activation;
}
