import { describe, expect, it } from "vitest";
import {
  parseSetUtilityInput,
  type ShadowSetUtilityInput
} from "../../../../recall/shadow/index.js";
import { prefixSK } from "../../../../recall/shadow/walk.js";
import {
  replayD1CaptureWalk
} from "../../../../recall/shadow/d1/index.js";
import { field, lexicalAt, view } from "../psi-test-support.js";
import { plantProof } from "./d1-proof-fixture.js";

const LEX = ["lexical"] as const;

describe("d1 frozen-Gamma walk replay", () => {
  it("replays prefix_sk with frozen Gamma and shrinks an equal-G cohort on a receipt edge", () => {
    const proof = plantProof({
      lanes: {
        porter: {
          rows: [{ key: "A", ordinal: 5 }],
          universeKeys: ["A", "B"]
        }
      }
    });
    const candidates = [
      walkCandidate("A", plantedUtility("A", { a1: 0.5, a2: 0 }, "gist:A"), 1),
      walkCandidate("B", plantedUtility("B", { a1: 0, a2: 0.5 }, "gist:B"), 2)
    ];
    const utilities = {
      A: candidates[0]!.utility,
      B: candidates[1]!.utility
    };
    const observations = field({
      A: view({ lexical: lexicalAt("not_observed") }),
      B: view({ lexical: lexicalAt("not_observed") })
    });
    const replayed = replayD1CaptureWalk({
      observations,
      applicableChannels: LEX,
      proofs: [proof],
      utilities,
      candidates,
      gold_keys: ["A"]
    });
    expect(replayed.kind).toBe("replayed");
    if (replayed.kind !== "replayed") return;
    expect(candidates[0]?.utility).toBe(utilities.A);
    expect(candidates[1]?.utility).toBe(utilities.B);
    expect(replayed.d1_walk.S_infty[0]).toBe("A");
    expect(replayed.metrics.receipt_backed_dominance_edges).toBeGreaterThan(0);
    expect(replayed.metrics.equal_g_cohort_shrink.baseline_cohorts_gt_1).toBeGreaterThan(0);
    expect(replayed.metrics.equal_g_cohort_shrink.shrunk).toBeGreaterThan(0);
    expect(replayed.baseline_walk.decisions[0]?.max_g_cohort).toEqual(["A", "B"]);
    expect(replayed.baseline_walk.decisions[0]?.equal_g_dominance_rejects).toEqual([]);
    expect(replayed.d1_walk.decisions[0]?.max_g_cohort).toEqual(["A", "B"]);
    expect(replayed.d1_walk.decisions[0]?.equal_g_dominance_rejects)
      .toEqual([{ candidate_key: "B", dominated_by: "A" }]);
    expect(replayed.metrics.any_at_5).toBe(true);
    expect(replayed.prefix_sk_5).toEqual(prefixSK(replayed.d1_walk.S_infty, 5));
    expect(replayed.metrics.missingness.production_not_observed).toBe(2);
    expect(replayed.metrics.missingness.legal_lane_envelopes).toBeGreaterThan(0);
    expect(replayed.metrics.f1_size).toBe(1);
    expect(replayed.metrics.h_size).toBe(2);
    expect(replayed.metrics.f1_over_h).toBeCloseTo(0.5);
    expect(replayed.metrics.mean_max_g_cohort_size).toBeGreaterThan(0);
    expect(replayed.metrics.deterministic_tail_share).toBeGreaterThanOrEqual(0);
    expect(replayed.metrics.blocked_pair_share).toBeGreaterThanOrEqual(0);
  });

  it("does not rebuild frozen Gamma rows when walk candidates are supplied", () => {
    const proof = plantProof({
      lanes: {
        porter: {
          rows: [{ key: "A", ordinal: 5 }],
          universeKeys: ["A", "B"]
        }
      }
    });
    const utilityA = plantedUtility("A");
    const utilityB = plantedUtility("B");
    const candidates = [
      walkCandidate("A", utilityA),
      walkCandidate("B", utilityB)
    ];
    const replayed = replayD1CaptureWalk({
      observations: field({
        A: view({ lexical: lexicalAt("not_observed") }),
        B: view({ lexical: lexicalAt("not_observed") })
      }),
      applicableChannels: LEX,
      proofs: [proof],
      utilities: { A: utilityA, B: utilityB },
      candidates
    });
    expect(replayed.kind).toBe("replayed");
    if (replayed.kind !== "replayed") return;
    expect(candidates[0]?.utility).toBe(utilityA);
    expect(candidates[1]?.utility).toBe(utilityB);
  });
});

function plantedUtility(
  key: string,
  covers: Readonly<Record<string, number>> = { topic: 0.5 },
  cid?: string
): ShadowSetUtilityInput {
  const entries = Object.entries(covers);
  const cidReceipt = cid === undefined
    ? { status: "unavailable" as const }
    : { status: "available" as const, cid, grounding: "gist" as const };
  return parseSetUtilityInput({
    schema_version: 1,
    candidate_key: key,
    object_key: key,
    obligations: entries.map(([value, strength]) => ({
      key: { kind: "entity", value },
      raw_atom_ids: [`typed:${value}`],
      availability: "available",
      cover: strength,
      evaluated: true
    })),
    matches: entries.map(([value, strength]) => ({
      obligation: { kind: "entity", value },
      raw_atom_id: `typed:${value}`,
      attribution_kind: "typed_query_atom",
      match_strength: strength
    })),
    values: { status: "no_match", values: [] },
    cid: cidReceipt,
    availability: {
      facility: "available",
      values: "no_match",
      evidence_identity: cidReceipt.status
    }
  });
}

function walkCandidate(
  key: string,
  utility: ShadowSetUtilityInput,
  frontier: number | null = null
) {
  return {
    candidate_key: key,
    object_key: utility.object_key,
    token_cost: 1,
    dimension: "mem",
    h_eligible: true,
    utility,
    static_frontier_index: frontier
  };
}
