import { describe, expect, it } from "vitest";
import {
  lowerFrontierNoveltyAdmission,
  parseSetUtilityInput
} from "../../../../recall/decision/prefix-capture/capture.js";

function utility(patch: Record<string, unknown> = {}) {
  return parseSetUtilityInput({
    schema_version: 1,
    candidate_key: "cand-a",
    object_key: "obj-a",
    obligations: [{
      key: { kind: "entity", value: "alice" },
      raw_atom_ids: ["typed:alice", "frame:alice"],
      availability: "available",
      cover: 0.4,
      evaluated: true
    }],
    matches: [
      {
        obligation: { kind: "entity", value: "alice" },
        raw_atom_id: "typed:alice",
        attribution_kind: "typed_query_atom",
        match_strength: 0.4
      },
      {
        obligation: { kind: "entity", value: "alice" },
        raw_atom_id: "frame:alice",
        attribution_kind: "typed_fact_frame",
        match_strength: 0.2
      }
    ],
    values: { status: "no_match", values: [] },
    cid: { status: "unavailable" },
    availability: {
      facility: "available",
      values: "no_match",
      evidence_identity: "unavailable"
    },
    ...patch
  });
}

describe("set-utility input receipts", () => {
  it("collapses correlated obligation aliases to one canonical key", () => {
    const parsed = utility();
    expect(parsed.obligations).toHaveLength(1);
    expect(parsed.matches).toHaveLength(2);
    expect(() => utility({
      obligations: [
        {
          key: { kind: "entity", value: "alice" },
          raw_atom_ids: ["typed:alice"],
          availability: "available",
          cover: 0.4,
          evaluated: true
        },
        {
          key: { kind: "entity", value: "alice" },
          raw_atom_ids: ["frame:alice"],
          availability: "available",
          cover: 0.2,
          evaluated: true
        }
      ]
    })).toThrow(/aliases/u);
  });

  it("keeps optional CID unavailable and rejects candidate-key fallback", () => {
    expect(utility().cid).toEqual({ status: "unavailable" });
    expect(utility({
      cid: { status: "available", cid: "gist:hello", grounding: "gist" },
      availability: {
        facility: "available",
        values: "no_match",
        evidence_identity: "available"
      }
    }).cid).toEqual({
      status: "available",
      cid: "gist:hello",
      grounding: "gist"
    });
    expect(() => utility({
      cid: { status: "available", cid: "cand-a", grounding: "gist" }
    })).toThrow(/fall back/u);
  });

  it("does not treat unavailable or not_observed cover as known-zero", () => {
    expect(() => utility({
      obligations: [{
        key: { kind: "entity", value: "alice" },
        raw_atom_ids: ["typed:alice"],
        availability: "known_zero",
        cover: 0,
        evaluated: false
      }]
    })).toThrow(/known-zero/u);
    expect(utility({
      obligations: [{
        key: { kind: "entity", value: "alice" },
        raw_atom_ids: ["typed:alice"],
        availability: "unavailable",
        cover: 0,
        evaluated: false
      }],
      availability: {
        facility: "unavailable",
        values: "no_match",
        evidence_identity: "unavailable"
      }
    }).obligations[0]?.availability).toBe("unavailable");
  });

  it("rejects FrontierPriority on the set-utility receipt", () => {
    expect(() => utility({ FrontierPriority: 1 })).toThrow(/FrontierPriority/u);
  });

  it("blocks lower-frontier exclusivity when Core is unavailable or not observed", () => {
    expect(lowerFrontierNoveltyAdmission({
      candidate_standing: "available_positive",
      core_standings: ["available_known_absent"]
    })).toBe("admitted");
    expect(lowerFrontierNoveltyAdmission({
      candidate_standing: "available_positive",
      core_standings: ["unavailable"]
    })).toBe("blocked");
    expect(lowerFrontierNoveltyAdmission({
      candidate_standing: "available_positive",
      core_standings: ["not_observed"]
    })).toBe("blocked");
    expect(lowerFrontierNoveltyAdmission({
      candidate_standing: "available_positive",
      core_standings: ["available_known_absent", "unavailable"]
    })).toBe("blocked");
  });
});
