import { afterEach, describe, expect, it } from "vitest";
import {
  QueryProgramSchema,
  productSubjectId,
  type QueryProgram
} from "@do-soul/alaya-protocol";
import { bindMaxMinField } from "../../../recall/conditional-field/reference/bind-max-min.js";
import { type StorageDatabase } from "@do-soul/alaya-storage";
import {
  cheapestCompleteWitness,
  enumerateSimplePaths,
  evaluateFacets,
  interpretFiniteProgram,
  joinHyperedgeAnd,
  joinHyperedgeOr,
  productKey
} from "./enumerate-simple-paths.js";
import {
  DEPLOYMENT_MILLIGRADES,
  QUERY_ID,
  RESULT_VERSION,
  SNAPSHOT_ID,
  cheapAlternateWitnesses,
  cyclicWorld,
  defaultBudget,
  defaultView,
  deploymentProgram,
  deploymentWorld,
  guardAppliesToVariable,
  hypothesisWorld,
  inGuardInterval,
  LAST_WEEK_INSTANT,
  longChainWorld,
  OBJECT_OBSERVED_AT,
  samePathFacetVectors,
  YESTERDAY_INSTANT,
  yesterdayAnchorGuard
} from "./finite-worlds.js";
import {
  compareObjectMilligrades,
  compareProducerField,
  plantBoundSlice
} from "./frozen-ports.js";
import { openBoundSlice } from "./bound-producer.js";
import {
  admitRequestBudget,
  milligradeOf,
  projectOracleIndex
} from "./oracle-index.js";

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("conditional-field independent field oracle", () => {
  it("keeps yesterday on the failed deployment and last-week config at 850", () => {
    const world = deploymentWorld();
    const field = enumerateSimplePaths(world.seeds, world.edges);
    expect(field.kind).toBe("enumerated");
    expect(milligradeOf(field, "c")).toBe(850);
    expect(milligradeOf(field, "r")).toBe(1000);
    const yesterday = yesterdayAnchorGuard();
    expect(guardAppliesToVariable(yesterday, "r")).toBe(true);
    expect(guardAppliesToVariable(yesterday, "c")).toBe(false);
    expect(inGuardInterval(YESTERDAY_INSTANT, yesterday.interval)).toBe(true);
    expect(inGuardInterval(LAST_WEEK_INSTANT, yesterday.interval)).toBe(false);
    const configObservedAt = OBJECT_OBSERVED_AT.c;
    if (configObservedAt === undefined) throw new Error("missing planted config timestamp");
    expect(inGuardInterval(configObservedAt, yesterday.interval)).toBe(false);
    const index = projectWorld(world, field);
    expect(index.entries.find((entry) => (entry.object_id ?? "") === "c")?.association_milligrades).toBe(850);
    const appliedEverywhere = index.entries.filter((entry) =>
      inGuardInterval(OBJECT_OBSERVED_AT[(entry.object_id ?? "")] ?? LAST_WEEK_INSTANT, yesterday.interval)
    );
    expect(appliedEverywhere.map((entry) => (entry.object_id ?? ""))).toEqual(["r"]);
  });

  it("includes prior same-service failure at 550 with unknown common cause", () => {
    const world = deploymentWorld();
    const field = enumerateSimplePaths(world.seeds, world.edges);
    const index = projectWorld(world, field);
    const history = index.entries.find((entry) => (entry.object_id ?? "") === "h");
    expect(milligradeOf(field, "h")).toBe(550);
    expect(history?.claim).toBe("unknown");
    expect(index.entries.find((entry) => (entry.object_id ?? "") === "s")).toBeUndefined();
    expect(history?.claim).not.toBe("supported");
  });

  it("keeps epsilon distinct from empty and does not pool hypotheses or bindings", () => {
    const epsilon = QueryProgramSchema.parse({ schema_version: 1, kind: "epsilon" });
    const empty = QueryProgramSchema.parse({ schema_version: 1, kind: "empty" });
    expect(epsilon.kind).not.toBe(empty.kind);
    expect(interpretFiniteProgram(epsilon).kind).toBe("epsilon");
    expect(interpretFiniteProgram(empty).kind).toBe("empty");
    const relation: QueryProgram = {
      schema_version: 1,
      kind: "relation",
      relation_kind: "associated_config",
      source_variable: "r",
      target_variable: "c",
      guard: { schema_version: 1, kind: "equality", verdict: "unresolved", variable: "c", time_scope: "none" },
      facet_mode: "same_path",
      threshold_milligrades: 0
    };
    expect(interpretFiniteProgram({ schema_version: 1, kind: "sequence", steps: [epsilon, relation] }))
      .toEqual({ kind: "program", program: relation });
    expect(interpretFiniteProgram({ schema_version: 1, kind: "sequence", steps: [empty, relation] }))
      .toEqual({ kind: "empty" });
    expect(interpretFiniteProgram({ schema_version: 1, kind: "alternative", options: [empty, relation] }))
      .toEqual({ kind: "program", program: relation });
    expect(interpretFiniteProgram({ schema_version: 1, kind: "alternative", options: [epsilon, empty] }))
      .toEqual({ kind: "epsilon" });
    const world = hypothesisWorld();
    const index = projectWorld(world, enumerateSimplePaths(world.seeds, world.edges));
    const rows = index.entries.filter((entry) => (entry.object_id ?? "") === "c");
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.hypothesis_id).sort()).toEqual(["h1", "h1", "h2"]);
    expect(rows.map((row) => row.output_binding).sort()).toEqual(["bind-b", "default", "default"]);
    expect(rows.find((row) => row.hypothesis_id === "h1" && row.output_binding === "default")
      ?.association_milligrades).toBe(850);
  });

  it("keeps long homogeneous chains and fan-out grades without hop attenuation", () => {
    const world = longChainWorld(20, 8);
    const field = enumerateSimplePaths(world.seeds, world.edges);
    expect(milligradeOf(field, "n20")).toBe(900);
    for (let index = 0; index < 8; index += 1) {
      expect(milligradeOf(field, `h${index}`)).toBe(550);
    }
    expect(milligradeOf(field, "n20")).not.toBeLessThan(900);
  });

  it("agrees with the freeze milligrades and does not amplify cycles", async () => {
    const world = deploymentWorld();
    const field = enumerateSimplePaths(world.seeds, world.edges);
    const counts = compareObjectMilligrades(field, DEPLOYMENT_MILLIGRADES);
    expect(counts.mismatches).toBe(0);
    expect(counts.unsupported).toBe(0);
    expect(milligradeOf(field, "u")).toBe(0);
    expect(field.witnesses.some((witness) => {
      const last = witness.nodes.at(-1);
      return last !== undefined && productSubjectId(last) === "u";
    })).toBe(false);
    const cyclic = enumerateSimplePaths(cyclicWorld().seeds, cyclicWorld().edges);
    expect(milligradeOf(cyclic, "a")).toBe(1000);
    expect(milligradeOf(cyclic, "b")).toBe(900);
    expect(milligradeOf(cyclic, "c")).toBe(800);
    const slice = await openBoundSlice((database) => databases.add(database));
    const ports = await plantBoundSlice(slice);
    const producer = compareProducerField(ports, world, defaultBudget(), { r: 1000, l: 1000, c: 1000, s: 1000, h: 1000, u: 0 });
    expect(producer.skipped_environments).toBe(0);
    expect(producer.mismatches).toBe(0);
  });

  it("rejects coordinate-wise max under same_path", () => {
    const vectors = samePathFacetVectors();
    expect(evaluateFacets("same_path", vectors, 800)).toBe(false);
    expect(evaluateFacets("independent", vectors, 800)).toBe(true);
    const world = deploymentWorld();
    const field = enumerateSimplePaths(
      [{ state: productKey("c"), milligrades: 900 }],
      []
    );
    const samePath = projectOracleIndex({
      field,
      view: { ...defaultView(), facet_mode: "same_path", threshold_milligrades: 800 },
      query_id: QUERY_ID,
      snapshot_id: SNAPSHOT_ID,
      result_version: RESULT_VERSION,
      budget: defaultBudget(),
      roles: world.roles,
      facets: vectors
    });
    expect(samePath.entries).toEqual([]);
    const independent = projectOracleIndex({
      field,
      view: { ...defaultView(), facet_mode: "independent", threshold_milligrades: 800 },
      query_id: QUERY_ID,
      snapshot_id: SNAPSHOT_ID,
      result_version: RESULT_VERSION,
      budget: defaultBudget(),
      roles: world.roles,
      facets: vectors
    });
    expect(independent.entries).toHaveLength(1);
  });

  it("requires AND premises under one binding and keeps complete OR witnesses", () => {
    expect(joinHyperedgeAnd([
      { hypothesis_id: "h0", binding_context: "default", time_state: "as_of", present: true },
      { hypothesis_id: "h0", binding_context: "default", time_state: "as_of", present: true }
    ])).toBe(true);
    expect(joinHyperedgeAnd([
      { hypothesis_id: "h0", binding_context: "bind-a", time_state: "as_of", present: true },
      { hypothesis_id: "h0", binding_context: "bind-b", time_state: "as_of", present: true }
    ])).toBe(false);
    expect(joinHyperedgeAnd([
      { hypothesis_id: "h1", binding_context: "default", time_state: "as_of", present: true },
      { hypothesis_id: "h2", binding_context: "default", time_state: "as_of", present: true }
    ])).toBe(false);
    expect(joinHyperedgeAnd([
      { hypothesis_id: "h0", binding_context: "default", time_state: "yesterday", present: true },
      { hypothesis_id: "h0", binding_context: "default", time_state: "as_of", present: true }
    ])).toBe(false);
    const witnesses = joinHyperedgeOr(cheapAlternateWitnesses());
    expect(witnesses.map((witness) => witness.witness_id)).toEqual(["expensive", "cheap"]);
  });

  it("keeps the cheap complete witness instead of a greedy strongest path", () => {
    const cheapest = cheapestCompleteWitness(cheapAlternateWitnesses(), 800);
    expect(cheapest?.witness_id).toBe("cheap");
    const greedyFirst = cheapAlternateWitnesses().find((witness) => witness.complete);
    expect(greedyFirst?.witness_id).toBe("expensive");
    expect(greedyFirst?.witness_id).not.toBe(cheapest?.witness_id);
  });

  it("rejects an envelope that cannot fit and admits a smaller page budget", () => {
    expect(admitRequestBudget(defaultBudget({
      work_units: 100,
      finalization_reserve: 20,
      min_envelope: 90
    }))).toBe("resource_rejected");
    expect(admitRequestBudget(defaultBudget({ page_budget: 2, min_envelope: 10 }))).toBe("admit");
    const world = deploymentWorld();
    const field = enumerateSimplePaths(world.seeds, world.edges);
    const first = projectOracleIndex({
      field,
      view: defaultView(),
      query_id: QUERY_ID,
      snapshot_id: SNAPSHOT_ID,
      result_version: RESULT_VERSION,
      budget: defaultBudget({ page_budget: 2, min_envelope: 10 }),
      expires_at: "2099-01-01T00:00:00.000Z",
      roles: world.roles,
      claims: world.claims
    });
    expect(first.entries.length).toBeLessThanOrEqual(2);
    expect(first.continuation).not.toBeNull();
  });

  it("treats seed 0 through a hard edge as reachable and an unseeded acceptor as unreachable", () => {
    const isolated = bindMaxMinField({
      query_id: QUERY_ID,
      snapshot_id: SNAPSHOT_ID,
      budget: defaultBudget(),
      seeds: [],
      transitions: [{
        schema_version: 1,
        from: productKey("z"),
        to: productKey("z"),
        relation_kind: "loop",
        strength_milligrades: 1000,
        validity: { kind: "open", valid_from: "2026-01-01T00:00:00.000Z" },
        applicable: true
      }]
    });
    if (isolated.kind !== "bound") throw new Error("expected bound field");
    const isolatedValue = isolated.snapshot.values.find((value) => productSubjectId(value.state) === "z");
    expect(isolatedValue?.activation).toEqual({ kind: "unreachable" });

    const reached = bindMaxMinField({
      query_id: QUERY_ID,
      snapshot_id: SNAPSHOT_ID,
      budget: defaultBudget(),
      seeds: [{ schema_version: 1, state: productKey("a"), milligrades: 0 }],
      transitions: [{
        schema_version: 1,
        from: productKey("a"),
        to: productKey("b"),
        relation_kind: "hard",
        strength_milligrades: 1000,
        validity: { kind: "open", valid_from: "2026-01-01T00:00:00.000Z" },
        applicable: true
      }]
    });
    if (reached.kind !== "bound") throw new Error("expected bound field");
    expect(reached.snapshot.values.find((value) => productSubjectId(value.state) === "b")?.activation)
      .toEqual({ kind: "reachable", milligrades: 0 });
  });

  it("parses the deployment program without aliasing epsilon and empty", () => {
    const program = QueryProgramSchema.parse(deploymentProgram());
    expect(program.kind).toBe("sequence");
    expect(interpretFiniteProgram({ schema_version: 1, kind: "epsilon" }).kind)
      .not.toBe(interpretFiniteProgram({ schema_version: 1, kind: "empty" }).kind);
  });
});

function projectWorld(world: ReturnType<typeof deploymentWorld>, field: ReturnType<typeof enumerateSimplePaths>) {
  return projectOracleIndex({
    field,
    view: defaultView(),
    query_id: QUERY_ID,
    snapshot_id: SNAPSHOT_ID,
    result_version: RESULT_VERSION,
    budget: defaultBudget(),
    roles: world.roles,
    claims: world.claims
  });
}
