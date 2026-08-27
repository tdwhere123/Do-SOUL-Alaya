import { describe, expect, it } from "vitest";
import {
  d1IntervalVote,
  d1LaneEnvelopes,
  d1LexicalChannelVote
} from "../../../../recall/shadow/d1/index.js";
import { plantProof } from "./d1-proof-fixture.js";

describe("d1 interval channel vote", () => {
  it("votes gt / lt / eq / skip on the same LexDomain", () => {
    expect(d1IntervalVote(interval(5, 5), interval(0, 0))).toBe("gt");
    expect(d1IntervalVote(interval(0, 0), interval(5, 5))).toBe("lt");
    expect(d1IntervalVote(interval(5, 5), interval(5, 5))).toBe("eq");
    expect(d1IntervalVote({ kind: "inapplicable" }, { kind: "inapplicable" })).toBe("skip");
  });

  it("treats overlapping intervals and reversible unbounded as incomparable", () => {
    expect(d1IntervalVote(interval(3, 3), interval(0, 5))).toBe("incomparable");
    expect(d1IntervalVote(interval(5, 5), interval(0, 5))).toBe("incomparable");
    expect(d1IntervalVote(interval(5, 5), { kind: "unbounded" })).toBe("incomparable");
    expect(d1IntervalVote({ kind: "unbounded" }, { kind: "unbounded" })).toBe("incomparable");
    expect(d1IntervalVote(interval(5, 5), { kind: "inapplicable" })).toBe("incomparable");
  });

  it("lets an observed point strictly above a truncated frontier dominate", () => {
    const proof = truncatedPorter();
    const vote = d1LexicalChannelVote(
      d1LaneEnvelopes(proof, "hit"),
      d1LaneEnvelopes(proof, "miss")
    );
    expect(vote).toBe("gt");
  });

  it("does not let an observed point on the truncated frontier dominate", () => {
    const proof = truncatedPorter();
    expect(d1LexicalChannelVote(
      d1LaneEnvelopes(proof, "front"),
      d1LaneEnvelopes(proof, "miss")
    )).toBe("incomparable");
  });

  it("compares a family-unbounded candidate on the primary LexDomain", () => {
    const proof = plantProof({
      lanes: {
        porter: {
          rows: [{ key: "hit", ordinal: 5 }],
          universeKeys: ["hit", "miss"]
        }
      }
    });
    expect(d1LexicalChannelVote(
      d1LaneEnvelopes(proof, "hit"),
      d1LaneEnvelopes(proof, "miss")
    )).toBe("gt");
  });

  it("does not compare one-lane absence against a different lane primary", () => {
    const proof = plantProof({
      lanes: {
        exact: {
          rows: [{ key: "hit", ordinal: 1 }],
          universeKeys: ["hit"]
        },
        porter: {
          universeKeys: ["miss"]
        }
      }
    });
    expect(d1LexicalChannelVote(
      d1LaneEnvelopes(proof, "hit"),
      d1LaneEnvelopes(proof, "miss")
    )).toBe("incomparable");
  });

  it("is incomparable across lane_id, list_n, and status", () => {
    const exact = plantProof({
      lanes: { exact: { rows: [{ key: "hit", ordinal: 1 }], universeKeys: ["hit"] } }
    });
    const porter = plantProof({
      lanes: { porter: { rows: [{ key: "other", ordinal: 5 }], universeKeys: ["other"] } }
    });
    expect(d1LexicalChannelVote(
      d1LaneEnvelopes(exact, "hit"),
      d1LaneEnvelopes(porter, "other")
    )).toBe("incomparable");
    const complete = plantProof({
      lanes: { porter: { rows: [{ key: "hit", ordinal: 5 }] } }
    });
    const truncated = plantProof({
      lanes: {
        porter: {
          rows: [{ key: "other", ordinal: 4 }, { key: "tail", ordinal: 2 }],
          limit: 2
        }
      }
    });
    expect(d1LexicalChannelVote(
      d1LaneEnvelopes(complete, "hit"),
      d1LaneEnvelopes(truncated, "other")
    )).toBe("incomparable");
  });

  it("does not mix relaxed and expanded proofs", () => {
    const lanes = {
      porter: { rows: [{ key: "hit", ordinal: 5 }], universeKeys: ["hit", "miss"] }
    };
    const relaxed = plantProof({ fieldPrefix: "lexical_relaxed", lanes });
    const expanded = plantProof({ fieldPrefix: "lexical_expanded", lanes });
    expect(d1LexicalChannelVote(
      d1LaneEnvelopes(relaxed, "hit"),
      d1LaneEnvelopes(expanded, "miss")
    )).toBe("incomparable");
  });

  it("does not mix distinct query_run_id identities", () => {
    const lanes = {
      porter: { rows: [{ key: "hit", ordinal: 5 }], universeKeys: ["hit", "miss"] }
    };
    const left = plantProof({ queryRunId: "memory.keyword.depth:2", lanes });
    const right = plantProof({ queryRunId: "memory.keyword.depth:10", lanes });
    expect(d1LexicalChannelVote(
      d1LaneEnvelopes(left, "hit"),
      d1LaneEnvelopes(right, "miss")
    )).toBe("incomparable");
  });

  it("skips when both family observations stay unknown", () => {
    const proof = plantProof({
      includeProvenance: false,
      lanes: {
        porter: { universeKeys: ["v"] },
        exact: { universeKeys: ["u"] }
      }
    });
    expect(d1LexicalChannelVote(
      d1LaneEnvelopes(proof, "v"),
      d1LaneEnvelopes(proof, "u")
    )).toBe("skip");
  });

  it("requires agreeing votes when several shared family domains exist", () => {
    const disagree = plantProof({
      includeProvenance: false,
      lanes: {
        exact: {
          rows: [{ key: "v", ordinal: 1 }, { key: "u", ordinal: 1 }],
          universeKeys: ["u", "v"]
        },
        porter: {
          rows: [{ key: "v", ordinal: 5 }],
          universeKeys: ["u", "v"]
        }
      }
    });
    expect(d1LexicalChannelVote(
      d1LaneEnvelopes(disagree, "v"),
      d1LaneEnvelopes(disagree, "u")
    )).toBe("incomparable");
    const agree = plantProof({
      includeProvenance: false,
      lanes: {
        exact: {
          rows: [{ key: "v", ordinal: 1 }],
          universeKeys: ["u", "v"]
        },
        porter: {
          rows: [{ key: "v", ordinal: 5 }],
          universeKeys: ["u", "v"]
        }
      }
    });
    expect(d1LexicalChannelVote(
      d1LaneEnvelopes(agree, "v"),
      d1LaneEnvelopes(agree, "u")
    )).toBe("gt");
  });

  it("skips when both lanes are no_tokens_routed", () => {
    const proof = plantProof({
      lanes: {
        exact: { tokensRouted: false },
        porter: { tokensRouted: false },
        trigram: { tokensRouted: false },
        object_key_porter: { tokensRouted: false },
        object_key_trigram: { tokensRouted: false }
      }
    });
    expect(d1LexicalChannelVote(
      d1LaneEnvelopes(proof, "v"),
      d1LaneEnvelopes(proof, "u")
    )).toBe("skip");
  });
});

function interval(lower: number, upper: number) {
  return { kind: "interval" as const, lower, upper };
}

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
