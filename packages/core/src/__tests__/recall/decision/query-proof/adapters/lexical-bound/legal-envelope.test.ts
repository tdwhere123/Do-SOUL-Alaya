import { describe, expect, it } from "vitest";
import {
  absentLexicalBoundProof,
  type LexicalBoundProof
} from "../../../../../../recall/runtime/diagnostics/lexical-bound-proof.js";
import { d1LaneEnvelopes } from "../../../../../../recall/decision/query-proof/adapters/lexical-bound/index.js";
import {
  D1_REQUEST,
  laneValue,
  plantProof,
  withIdentity
} from "./d1-proof-fixture.js";

const HIT_MISS_PORTER = {
  porter: {
    rows: [{ key: "hit", ordinal: 5 }],
    universeKeys: ["hit", "miss"]
  }
} as const;

describe("d1 legal envelopes", () => {
  it("bounds complete-list in-universe absence at [0, 0]", () => {
    const map = d1LaneEnvelopes(plantProof({ lanes: HIT_MISS_PORTER }), "miss");
    expect(laneValue(map, "porter")).toEqual({ kind: "interval", lower: 0, upper: 0 });
    expect(map.primary).toBeNull();
    expect(map.identity?.field_prefix).toBe("lexical_relaxed");
    expect(map.query_run_id).toBe("memory.keyword.depth:10");
  });

  it("uses the producer grouped_ordinal as a point for an observed row", () => {
    const map = d1LaneEnvelopes(plantProof({ lanes: HIT_MISS_PORTER }), "hit");
    expect(laneValue(map, "porter")).toEqual({ kind: "interval", lower: 5, upper: 5 });
    expect(map.primary?.envelope).toEqual({ kind: "interval", lower: 5, upper: 5 });
    expect(map.primary?.domain).toMatchObject({
      lane_id: "porter",
      status: "complete",
      raw_key_kind: "bm25_raw_rank"
    });
  });

  it("bounds truncated in-universe absence at [0, frontier]", () => {
    const proof = truncatedPorter();
    expect(laneValue(d1LaneEnvelopes(proof, "miss"), "porter"))
      .toEqual({ kind: "interval", lower: 0, upper: 3 });
    expect(laneValue(d1LaneEnvelopes(proof, "hit"), "porter"))
      .toEqual({ kind: "interval", lower: 5, upper: 5 });
    expect(laneValue(d1LaneEnvelopes(proof, "front"), "porter"))
      .toEqual({ kind: "interval", lower: 3, upper: 3 });
  });

  it("keeps a non-admitted producer-observed row as a point", () => {
    const proof = plantProof({
      lanes: {
        porter: {
          rows: [{ key: "p3", ordinal: 4, admitted: false }],
          universeKeys: ["p3"]
        }
      }
    });
    const map = d1LaneEnvelopes(proof, "p3");
    expect(proof.receipt.candidates[0]?.admitted).toBe(false);
    expect(laneValue(map, "porter")).toEqual({ kind: "interval", lower: 4, upper: 4 });
    expect(map.primary?.envelope).toEqual({ kind: "interval", lower: 4, upper: 4 });
  });

  it("maps a memory_entry field key onto truncated proof rows keyed by object id", () => {
    const proof = plantProof({
      lanes: {
        porter: {
          rows: [
            { key: "p1", ordinal: 5 },
            { key: "p2", ordinal: 3 },
            { key: "p3", ordinal: 0, admitted: false }
          ],
          limit: 2,
          universeKeys: ["p1", "p2", "p3"]
        }
      }
    });
    const fieldKey = "workspace_local:memory_entry:p3";
    const raw = d1LaneEnvelopes(proof, "p3");
    const mapped = d1LaneEnvelopes(proof, fieldKey);
    expect(laneValue(mapped, "porter")).toEqual(laneValue(raw, "porter"));
    expect(mapped.primary).toEqual(raw.primary);
    expect(laneValue(mapped, "porter")).toEqual({ kind: "interval", lower: 0, upper: 0 });
    expect(laneValue(d1LaneEnvelopes(proof, "workspace_local:evidence_capsule:p3"), "porter"))
      .toEqual({ kind: "unbounded" });
  });

  it("forms complete-absence intervals from memory_entry field keys", () => {
    const proof = plantProof({ lanes: HIT_MISS_PORTER });
    const miss = "workspace_local:memory_entry:miss";
    const hit = "global:memory_entry:hit";
    expect(laneValue(d1LaneEnvelopes(proof, miss), "porter"))
      .toEqual({ kind: "interval", lower: 0, upper: 0 });
    expect(laneValue(d1LaneEnvelopes(proof, hit), "porter"))
      .toEqual({ kind: "interval", lower: 5, upper: 5 });
    expect(d1LaneEnvelopes(proof, miss).primary).toBeNull();
  });

  it("does not turn one-lane absence into family-zero on another lane", () => {
    const map = d1LaneEnvelopes(plantProof({ lanes: HIT_MISS_PORTER }), "miss");
    expect(laneValue(map, "porter")).toEqual({ kind: "interval", lower: 0, upper: 0 });
    expect(laneValue(map, "exact")).toEqual({ kind: "unbounded" });
    expect(laneValue(map, "trigram")).toEqual({ kind: "unbounded" });
    expect(map.primary).toBeNull();
  });

  it("returns inapplicable for no_tokens_routed instead of [0, 0]", () => {
    const map = d1LaneEnvelopes(plantProof({
      lanes: { porter: { tokensRouted: false } }
    }), "miss");
    expect(laneValue(map, "porter")).toEqual({ kind: "inapplicable" });
    expect(laneValue(map, "porter")).not.toEqual({ kind: "interval", lower: 0, upper: 0 });
  });

  it("returns unbounded when snapshot or request is unsealed", () => {
    const missingSnapshot = d1LaneEnvelopes(plantProof({
      snapshotDigest: null,
      lanes: HIT_MISS_PORTER
    }), "miss");
    const missingRequest = d1LaneEnvelopes(plantProof({
      requestDigest: null,
      lanes: HIT_MISS_PORTER
    }), "miss");
    expect(laneValue(missingSnapshot, "porter")).toEqual({ kind: "unbounded" });
    expect(laneValue(missingRequest, "porter")).toEqual({ kind: "unbounded" });
    expect(missingSnapshot.identity).toBeNull();
  });

  it("returns unbounded when snapshot equals request", () => {
    const proof = plantProof({ lanes: HIT_MISS_PORTER });
    const cloned = withIdentity(proof, {
      ...proof.identity,
      snapshot_digest: proof.identity.request_digest
    });
    expect(cloned.identity.snapshot_digest).toBe(D1_REQUEST);
    expect(laneValue(d1LaneEnvelopes(cloned, "miss"), "porter"))
      .toEqual({ kind: "unbounded" });
  });

  it("returns unbounded when the per-lane universe is missing", () => {
    const map = d1LaneEnvelopes(plantProof({
      universes: false,
      lanes: HIT_MISS_PORTER
    }), "miss");
    expect(laneValue(map, "porter")).toEqual({ kind: "unbounded" });
  });

  it("returns unbounded when the candidate is outside the lane universe", () => {
    const map = d1LaneEnvelopes(plantProof({
      lanes: {
        porter: {
          rows: [{ key: "hit", ordinal: 5 }],
          universeKeys: ["hit"]
        }
      }
    }), "miss");
    expect(laneValue(map, "porter")).toEqual({ kind: "unbounded" });
  });

  it("returns unbounded for a non-memory_object_id key domain", () => {
    const omitted = d1LaneEnvelopes(plantProof({
      keyDomain: "omit",
      lanes: HIT_MISS_PORTER
    }), "miss");
    const evidence = d1LaneEnvelopes({
      ...plantProof({ lanes: HIT_MISS_PORTER }),
      candidate_key_domain: "evidence_capsule_id"
    } as unknown as LexicalBoundProof, "miss");
    expect(laneValue(omitted, "porter")).toEqual({ kind: "unbounded" });
    expect(laneValue(evidence, "porter")).toEqual({ kind: "unbounded" });
  });

  it("returns unbounded for a truncated non-monotone unavailable frontier", () => {
    const proof = plantProof({
      lanes: {
        porter: {
          rows: [
            { key: "hit", ordinal: 5, raw: 4 },
            { key: "front", ordinal: 3, raw: 1 }
          ],
          limit: 2,
          frontier: "unavailable",
          universeKeys: ["front", "hit", "miss"]
        }
      }
    });
    expect(proof.receipt.lanes.find((lane) => lane.lane_id === "porter")
      ?.unseen_upper_bound).toEqual({
      status: "unavailable",
      reason: "producer_order_not_monotone"
    });
    expect(laneValue(d1LaneEnvelopes(proof, "miss"), "porter"))
      .toEqual({ kind: "unbounded" });
  });

  it("does not form envelopes from an absent proof", () => {
    const map = d1LaneEnvelopes(absentLexicalBoundProof(), "miss");
    expect(map.lanes).toEqual({});
    expect(map.identity).toBeNull();
  });
});

function truncatedPorter() {
  return plantProof({
    lanes: {
      porter: {
        rows: [
          { key: "hit", ordinal: 5 },
          { key: "front", ordinal: 3 }
        ],
        limit: 2,
        universeKeys: ["front", "hit", "miss"]
      }
    }
  });
}
