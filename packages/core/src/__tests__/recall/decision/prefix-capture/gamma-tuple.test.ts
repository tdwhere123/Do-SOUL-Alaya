import { describe, expect, it } from "vitest";
import {
  parseSetUtilityInput,
  SHADOW_GAMMA_KINDS,
  type ShadowObligationKey,
  type ShadowSetUtilityInput
} from "../../../../recall/decision/prefix-capture/capture.js";
import {
  acceptCandidate,
  compareGammaTuple,
  computeGammaTuple,
  emptySelectedSet,
  obligationUniverseFrom,
  readObligationCover
} from "../../../../recall/decision/prefix-capture/gamma-tuple.js";

const FORBIDDEN_G = [
  "FrontierPriority",
  "frontier_priority",
  "fused_score",
  "temporalFit",
  "quality",
  "admission",
  "flood",
  "graphExpansionScores"
] as const;

function atom(value: string, kind: ShadowObligationKey["kind"] = "entity"): ShadowObligationKey {
  return { kind, value };
}

function utility(key: string, patch: Record<string, unknown> = {}): ShadowSetUtilityInput {
  const obligations = (patch.obligations as unknown[] | undefined) ?? [];
  const values = (patch.values as { status?: string } | undefined) ?? { status: "no_match", values: [] };
  const cid = (patch.cid as { status?: string } | undefined) ?? { status: "unavailable" };
  return parseSetUtilityInput({
    schema_version: 1,
    candidate_key: key,
    object_key: key,
    obligations,
    matches: [],
    values: { status: "no_match", values: [] },
    cid: { status: "unavailable" },
    availability: {
      facility: obligations.length === 0 ? "not_applicable" : "available",
      values: values.status ?? "no_match",
      evidence_identity: cid.status ?? "unavailable"
    },
    ...patch
  });
}

function cover(value: string, strength: number, availability = "available") {
  return {
    key: { kind: "entity" as const, value },
    raw_atom_ids: [`typed:${value}`],
    availability,
    cover: availability === "unavailable" || availability === "not_observed" ? 0 : strength,
    evaluated: availability === "available" || availability === "known_zero"
  };
}

function match(value: string, strength: number, raw: string, kind: "typed_query_atom" | "typed_fact_frame") {
  return {
    obligation: { kind: "entity" as const, value },
    raw_atom_id: raw,
    attribution_kind: kind,
    match_strength: strength
  };
}

describe("S-dependent lexicographic Gamma", () => {
  it("exposes only unscaled remainder, Values_v, and evidence novelty", () => {
    const candidate = utility("A", {
      obligations: [cover("a1", 1)],
      matches: [match("a1", 1, "typed:a1", "typed_query_atom")],
      cid: { status: "available", cid: "gist:A", grounding: "gist" },
      availability: {
        facility: "available",
        values: "no_match",
        evidence_identity: "available"
      }
    });
    const g = computeGammaTuple(candidate, emptySelectedSet(), [atom("a1")]);
    expect(Object.keys(g).sort()).toEqual([...SHADOW_GAMMA_KINDS].sort());
    expect(SHADOW_GAMMA_KINDS).toEqual([
      "unscaled_remainder",
      "Values_v",
      "evidence_novelty_redundancy"
    ]);
    for (const field of FORBIDDEN_G) expect(g).not.toHaveProperty(field);
  });

  it("shrinks facility remainder after S covers the same obligation", () => {
    const universe = [atom("a1")];
    const a = utility("A", {
      obligations: [cover("a1", 1)],
      matches: [match("a1", 1, "typed:a1", "typed_query_atom")],
      cid: { status: "available", cid: "gist:A", grounding: "gist" },
      availability: {
        facility: "available",
        values: "no_match",
        evidence_identity: "available"
      }
    });
    const b = utility("B", {
      obligations: [cover("a1", 1)],
      matches: [match("a1", 1, "typed:a1", "typed_query_atom")],
      cid: { status: "available", cid: "gist:B", grounding: "gist" },
      availability: {
        facility: "available",
        values: "no_match",
        evidence_identity: "available"
      }
    });
    const empty = emptySelectedSet();
    expect(computeGammaTuple(a, empty, universe)).toMatchObject({
      unscaled_remainder: 1,
      Values_v: 0,
      evidence_novelty_redundancy: 1
    });
    expect(computeGammaTuple(b, empty, universe).unscaled_remainder).toBe(1);
    const afterA = acceptCandidate(empty, a, universe);
    expect(computeGammaTuple(b, afterA, universe)).toMatchObject({
      unscaled_remainder: 0,
      Values_v: 0,
      evidence_novelty_redundancy: 1
    });
  });

  it("takes max match strength for correlated (kind,value) aliases", () => {
    const universe = [atom("alice")];
    const candidate = utility("A", {
      obligations: [cover("alice", 0.4)],
      matches: [
        match("alice", 0.4, "typed:alice", "typed_query_atom"),
        match("alice", 0.2, "frame:alice", "typed_fact_frame")
      ],
      availability: {
        facility: "available",
        values: "no_match",
        evidence_identity: "unavailable"
      }
    });
    expect(readObligationCover(candidate, atom("alice")).cover).toBe(0.4);
    expect(computeGammaTuple(candidate, emptySelectedSet(), universe).unscaled_remainder)
      .toBe(0.4);
    const duplicated = utility("A", {
      obligations: [cover("alice", 0.4)],
      matches: [
        match("alice", 0.4, "typed:alice", "typed_query_atom"),
        match("alice", 0.2, "frame:alice", "typed_fact_frame"),
        match("alice", 0.2, "frame:alice-copy", "typed_fact_frame")
      ],
      availability: {
        facility: "available",
        values: "no_match",
        evidence_identity: "unavailable"
      }
    });
    expect(computeGammaTuple(duplicated, emptySelectedSet(), universe).unscaled_remainder)
      .toBe(0.4);
  });

  it("drops unavailable Values and CID without minting known-zero novelty", () => {
    const missing = utility("A", {
      values: { status: "unavailable", values: [] },
      cid: { status: "unavailable" },
      availability: {
        facility: "not_applicable",
        values: "unavailable",
        evidence_identity: "unavailable"
      }
    });
    const g = computeGammaTuple(missing, emptySelectedSet(), []);
    expect(g).toEqual({
      unscaled_remainder: 0,
      Values_v: 0,
      evidence_novelty_redundancy: 0
    });
    expect(missing.availability.values).toBe("unavailable");
    expect(missing.availability.evidence_identity).toBe("unavailable");
    expect(missing.cid).toEqual({ status: "unavailable" });
  });

  it("keeps G_status distinct when numeric gains are already zero", () => {
    const universe = [atom("a1")];
    const composed = utility("A", {
      values: {
        status: "composed",
        values: [{ variable_id: "v", semantic_identity: "s" }]
      },
      cid: { status: "available", cid: "gist:A", grounding: "gist" },
      availability: {
        facility: "not_applicable",
        values: "composed",
        evidence_identity: "available"
      }
    });
    const selected = acceptCandidate(emptySelectedSet(), composed, universe);
    const after = computeGammaTuple(composed, selected, universe);
    expect(after).toEqual({
      unscaled_remainder: 0,
      Values_v: 0,
      evidence_novelty_redundancy: 0
    });
    expect(composed.availability.values).toBe("composed");
    expect(composed.availability.evidence_identity).toBe("available");
    const unavailable = utility("B", {
      values: { status: "unavailable", values: [] },
      cid: { status: "unavailable" },
      availability: {
        facility: "not_applicable",
        values: "unavailable",
        evidence_identity: "unavailable"
      }
    });
    expect(computeGammaTuple(unavailable, selected, universe)).toEqual(after);
    expect(unavailable.availability.values).toBe("unavailable");
    expect(unavailable.availability.evidence_identity).toBe("unavailable");
  });

  it("orders lexicographically with facility before Values before evidence", () => {
    const tinyFac = utility("A", {
      obligations: [cover("a1", 0.0001)],
      matches: [match("a1", 0.0001, "typed:a1", "typed_query_atom")],
      availability: {
        facility: "available",
        values: "no_match",
        evidence_identity: "unavailable"
      }
    });
    const hugeVal = utility("B", {
      values: {
        status: "composed",
        values: Array.from({ length: 3 }, (_, i) => ({
          variable_id: `v${i}`,
          semantic_identity: `s${i}`
        }))
      },
      cid: { status: "available", cid: "gist:B", grounding: "gist" },
      availability: {
        facility: "not_applicable",
        values: "composed",
        evidence_identity: "available"
      }
    });
    const gA = computeGammaTuple(tinyFac, emptySelectedSet(), [atom("a1")]);
    const gB = computeGammaTuple(hugeVal, emptySelectedSet(), [atom("a1")]);
    expect(gA.unscaled_remainder).toBe(0.0001);
    expect(gB.Values_v).toBe(3);
    expect(gB.evidence_novelty_redundancy).toBe(1);
    expect(compareGammaTuple(gA, gB)).toBe(1);
  });

  it("treats kind=relation remainder as S-dependent cover, not Path proof", () => {
    const rel = atom("knows", "relation");
    const a = utility("A", {
      obligations: [{
        key: rel,
        raw_atom_ids: ["typed:knows"],
        availability: "available",
        cover: 1,
        evaluated: true
      }],
      matches: [{
        obligation: rel,
        raw_atom_id: "typed:knows",
        attribution_kind: "typed_query_atom",
        match_strength: 1
      }],
      availability: {
        facility: "available",
        values: "no_match",
        evidence_identity: "unavailable"
      }
    });
    const empty = emptySelectedSet();
    expect(computeGammaTuple(a, empty, [rel]).unscaled_remainder).toBe(1);
    expect(computeGammaTuple(a, acceptCandidate(empty, a, [rel]), [rel])
      .unscaled_remainder).toBe(0);
  });

  it("unions query obligations without double-counting aliases", () => {
    const a = utility("A", {
      obligations: [cover("alice", 0.4)],
      matches: [match("alice", 0.4, "typed:alice", "typed_query_atom")],
      availability: {
        facility: "available",
        values: "no_match",
        evidence_identity: "unavailable"
      }
    });
    const b = utility("B", {
      obligations: [cover("alice", 0.1), cover("bob", 1)],
      matches: [
        match("alice", 0.1, "typed:alice", "typed_query_atom"),
        match("bob", 1, "typed:bob", "typed_query_atom")
      ],
      availability: {
        facility: "available",
        values: "no_match",
        evidence_identity: "unavailable"
      }
    });
    const universe = obligationUniverseFrom([a, b]);
    expect(universe).toHaveLength(2);
    expect(computeGammaTuple(a, emptySelectedSet(), universe).unscaled_remainder)
      .toBe(0.4);
  });
});
