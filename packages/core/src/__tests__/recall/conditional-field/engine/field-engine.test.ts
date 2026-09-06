import { describe, expect, it } from "vitest";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  MILLIGRADE_TOP,
  type CoverageRegion,
  type FacetVector,
  type ObserverPage,
  type ObserverStatus,
  type ProductStateKey,
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
import {
  samePathAccepts,
  serialMin,
  tryCompleteHyperedge
} from "../../../../recall/conditional-field/engine/path-composition.js";
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
    expect(valueOf(state, "c")).toBe(850);
    expect(valueOf(state, "h")).toBe(550);
    expect(valueOf(state, "r")).toBe(1000);
    expect(valueOf(state, "l")).toBe(950);
    expect(valueOf(state, "s")).toBe(900);
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
    expect(valueOf(withClaim, "h")).toBe(550);
    expect(withClaim.support[0]?.claim).toBe("unknown");
    expect(withClaim.binding.kind).toBe("bound");
    if (withClaim.binding.kind !== "bound") return;
    expect(withClaim.binding.snapshot.retained_transitions.some((row) => row.to.object_id === "u"))
      .toBe(false);
  });

  it("A04 keeps long homogeneous chains and shared-service fan-out without hop attenuation", () => {
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

  it("A07 completes hyperedge AND only under one binding and all premises", () => {
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
    expect(incomplete.transitions).toEqual([]);
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
    expect(openKinds(state.residuals).sort()).toEqual(["adjacency", "binding", "guard", "seed"]);
    expect(projectFieldDelta(state).accepted_states.find((row) => row.state.object_id === "x"))
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
    expect(state.facets[0]?.coordinates).toEqual([900, 200]);
    expect(state.facets[1]?.coordinates).toEqual([200, 900]);
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

  it("never drops seen identities when memory is exhausted", () => {
    const hops: Transition[] = [];
    for (let index = 0; index < 8; index += 1) {
      hops.push(edge(productKey(`n${index}`), productKey(`n${index + 1}`), "chain", 900, true));
    }
    const state = createConditionalField({
      interpretation: interpretation(),
      budget: defaultBudget({ memory_bytes: 300, work_units: 50, finalization_reserve: 5 }),
      seeds: [seed(productKey("n0"), 900)],
      transitions: hops
    });
    expect(state.seen_identities.length).toBeGreaterThan(state.identity_spool.length);
    expect(state.identity_spool.length).toBeGreaterThan(0);
    expect(state.memory_exhausted).toBe(true);
    expect(state.seen_identities.map((row) => row.object_id).sort())
      .toEqual(["n0", "n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8"]);
    expect(state.remaining_reserve).toBe(5);
    expect(valueOf(state, "n8")).toBe(900);
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

  it("keeps a usable field and the finalization reserve when exploration work is exhausted", () => {
    const state = createConditionalField({
      interpretation: interpretation(),
      budget: defaultBudget({ work_units: 8, finalization_reserve: 2, min_envelope: 1 }),
      seeds: deploymentSeeds(),
      transitions: deploymentTransitions()
    });
    expect(state.binding.kind).toBe("bound");
    expect(valueOf(state, "c")).toBe(850);
    expect(state.remaining_reserve).toBe(2);
    expect(state.remaining_work.some((item) => item.kind === "state_create" || item.kind === "relaxation"))
      .toBe(true);
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
  return state.binding.snapshot.values.find((row) => row.state.object_id === objectId)
    ?.milligrades ?? 0;
}
