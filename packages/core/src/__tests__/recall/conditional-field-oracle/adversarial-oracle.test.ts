import { describe, expect, it } from "vitest";
import type { FacetVector, InformationIndex, Witness } from "@do-soul/alaya-protocol";
import {
  cheapestCompleteWitness,
  enumerateSimplePaths,
  evaluateFacets,
  interpretFiniteProgram
} from "./enumerate-simple-paths.js";
import {
  DEPLOYMENT_MILLIGRADES,
  QUERY_ID,
  RESULT_VERSION,
  SNAPSHOT_ID,
  cheapAlternateWitnesses,
  defaultBudget,
  defaultView,
  deploymentWorld,
  longChainWorld,
  samePathFacetVectors
} from "./finite-worlds.js";
import {
  compareObjectMilligrades,
  compareProducerField,
  pageMasqueradesAsFullIndex,
  sumsCounts,
  unboundPorts
} from "./frozen-ports.js";
import {
  emptyCounts,
  mapNativeReaderPage,
  milligradeOf,
  projectOracleIndex,
  tally,
  type OracleCounts
} from "./oracle-index.js";

describe("conditional-field adversarial falsifiers", () => {
  it("detects same-path coordinate-max fabrication", () => {
    const vectors = samePathFacetVectors();
    expect(evaluateFacets("same_path", vectors, 800)).toBe(false);
    expect(fabricateCoordinateMax(vectors, 800)).toBe(true);
    let counts = emptyCounts();
    counts = record(counts, evaluateFacets("same_path", vectors, 800) === fabricateCoordinateMax(vectors, 800));
    expect(counts.mismatches).toBe(1);
    expect(counts.matches).toBe(0);
  });

  it("detects epsilon/empty aliasing", () => {
    const epsilon = interpretFiniteProgram({ schema_version: 1, kind: "epsilon" });
    const empty = interpretFiniteProgram({ schema_version: 1, kind: "empty" });
    const aliased = aliasEpsilonAsEmpty(epsilon.kind);
    let counts = emptyCounts();
    counts = record(counts, epsilon.kind === empty.kind);
    counts = record(counts, aliased === "empty");
    expect(epsilon.kind).not.toBe(empty.kind);
    expect(counts.mismatches).toBe(1);
    expect(counts.matches).toBe(1);
  });

  it("detects truncated-zero reported as known empty", () => {
    const expected = mapNativeReaderPage({ ids: [], truncated: true, readerAvailable: true });
    const wrong = { status: "exhausted" as const, coverage: "exhausted_empty" as const };
    expect(expected.outcome.status).toBe("interrupted");
    let counts = emptyCounts();
    counts = record(counts, expected.outcome.status === wrong.status);
    expect(counts.mismatches).toBe(1);
  });

  it("detects hop attenuation on a long equal-strength chain", () => {
    const world = longChainWorld(20, 8);
    const field = enumerateSimplePaths(world.seeds, world.edges);
    const attenuated = hopAttenuate(900, 20);
    expect(milligradeOf(field, "n20")).toBe(900);
    expect(attenuated).toBeLessThan(900);
    let counts = emptyCounts();
    counts = record(counts, milligradeOf(field, "n20") === attenuated);
    expect(counts.mismatches).toBe(1);
  });

  it("detects required common-cause on shared-service history", () => {
    const world = deploymentWorld();
    const field = enumerateSimplePaths(world.seeds, world.edges);
    const index = projectOracleIndex({
      field,
      view: defaultView(),
      query_id: QUERY_ID,
      snapshot_id: SNAPSHOT_ID,
      result_version: RESULT_VERSION,
      budget: defaultBudget(),
      roles: world.roles,
      claims: world.claims
    });
    const history = index.entries.find((entry) => entry.object_id === "h");
    expect(history?.claim).toBe("unknown");
    const requiredCause = "supported";
    let counts = emptyCounts();
    counts = record(counts, history?.claim === requiredCause);
    expect(counts.mismatches).toBe(1);
  });

  it("detects treating a page as the full index", () => {
    const world = deploymentWorld();
    const field = enumerateSimplePaths(world.seeds, world.edges);
    const first = projectOracleIndex({
      field,
      view: defaultView(),
      query_id: QUERY_ID,
      snapshot_id: SNAPSHOT_ID,
      result_version: RESULT_VERSION,
      budget: defaultBudget({ page_budget: 1 }),
      expires_at: "2099-01-01T00:00:00.000Z",
      roles: world.roles,
      claims: world.claims
    });
    expect(pageMasqueradesAsFullIndex(first)).toBe(false);
    const wrong = masqueradePageAsFull(first);
    expect(pageMasqueradesAsFullIndex(wrong)).toBe(true);
    let counts = emptyCounts();
    counts = record(counts, pageMasqueradesAsFullIndex(first));
    counts = record(counts, pageMasqueradesAsFullIndex(wrong) === false);
    expect(counts.mismatches).toBe(2);
  });

  it("does not treat a greedy first complete witness as the affordable optimum", () => {
    const witnesses = cheapAlternateWitnesses();
    const cheapest = cheapestCompleteWitness(witnesses, 800);
    const greedy = greedyStrongest(witnesses);
    expect(cheapest?.witness_id).toBe("cheap");
    expect(greedy?.witness_id).toBe("expensive");
    let counts = emptyCounts();
    counts = record(counts, cheapest?.witness_id === greedy?.witness_id);
    expect(counts.mismatches).toBe(1);
  });

  it("keeps mismatch, unsupported, observation-hole and skipped buckets separate", () => {
    const world = deploymentWorld();
    const field = enumerateSimplePaths(world.seeds, world.edges);
    const expected = compareObjectMilligrades(field, DEPLOYMENT_MILLIGRADES);
    const skipped = tally(emptyCounts(), "skipped_environments");
    const unsupported = enumerateSimplePaths(
      world.seeds,
      Array.from({ length: 49 }, (_, index) => ({
        from: world.seeds[0]!.state,
        to: world.seeds[0]!.state,
        relation_kind: `dup-${index}`,
        strength_milligrades: 1,
        applicable: true,
        cost: 1
      }))
    );
    const holes = tally(emptyCounts(), "observation_holes");
    const total = sumsCounts([
      expected,
      skipped,
      unsupported.kind === "unsupported" ? tally(emptyCounts(), "unsupported") : emptyCounts(),
      holes
    ]);
    expect(expected.mismatches).toBe(0);
    expect(total.mismatches).toBe(0);
    expect(total.unsupported).toBe(1);
    expect(total.observation_holes).toBe(1);
    expect(total.skipped_environments).toBe(1);
    expect(total.matches).toBeGreaterThan(0);
    expect(unboundPorts().bound).toBe(false);
    expect(() => compareProducerField(unboundPorts(), world, defaultBudget(), DEPLOYMENT_MILLIGRADES))
      .toThrow(/bound production ports/);
  });
});

function record(counts: OracleCounts, matched: boolean): OracleCounts {
  return tally(counts, matched ? "matches" : "mismatches");
}

function fabricateCoordinateMax(vectors: readonly FacetVector[], threshold: number): boolean {
  const width = Math.max(...vectors.map((vector) => vector.coordinates.length));
  const fabricated: number[] = [];
  for (let index = 0; index < width; index += 1) {
    fabricated.push(Math.max(...vectors.map((vector) => vector.coordinates[index] ?? 0)));
  }
  return fabricated.every((value) => value > threshold);
}

function aliasEpsilonAsEmpty(kind: string): "empty" {
  return kind === "epsilon" || kind === "empty" ? "empty" : "empty";
}

function hopAttenuate(strength: number, hops: number): number {
  return Math.max(0, strength - hops * 10);
}

function masqueradePageAsFull(index: InformationIndex): InformationIndex {
  return {
    ...index,
    continuation: index.continuation,
    completeness: {
      ...index.completeness,
      logical_index: "complete",
      transport: "complete",
      payload: "complete"
    }
  };
}

function greedyStrongest(witnesses: readonly Witness[]): Witness | undefined {
  return witnesses.find((witness) => witness.complete);
}
