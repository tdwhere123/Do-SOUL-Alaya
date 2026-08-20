import { describe, expect, it } from "vitest";

import {
  assertRecallFiniteFieldRefinement,
  createRecallFiniteFieldSeal,
  verifyRecallFiniteFieldSeal
} from "../../../recall/field/finite-field-seal.js";
import { computeFixedFamilyRankBase } from
  "../../../recall/field/family-rank-base.js";

const SNAPSHOT = `sha256:${"a".repeat(64)}` as const;

describe("finite recall field seal", () => {
  it("binds channel order, observations, bounds and upstream snapshot", () => {
    const seal = createRecallFiniteFieldSeal({
      channel_catalog: ["semantic", "lexical"],
      upstream_snapshot_digest: SNAPSHOT,
      channels: [
        channel("lexical", "complete", 2, 0, [
          observation("lexical:a", "candidate-a", 1),
          observation("lexical:b", "candidate-b", 2)
        ]),
        channel("semantic", "unavailable", 0, null, [])
      ]
    });

    expect(seal.channels.map(({ channel_id }) => channel_id)).toEqual([
      "semantic",
      "lexical"
    ]);
    expect(seal.seal_digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(seal.channels.every(({ channel_digest }) =>
      /^sha256:[0-9a-f]{64}$/u.test(channel_digest))).toBe(true);
    expect(() => verifyRecallFiniteFieldSeal(seal)).not.toThrow();
    expect(() => verifyRecallFiniteFieldSeal({
      ...seal,
      upstream_snapshot_digest: `sha256:${"b".repeat(64)}`
    })).toThrow(/digest/u);
    expect(() => verifyRecallFiniteFieldSeal({
      ...seal,
      operator_id: "tampered_operator"
    } as unknown as typeof seal)).toThrow(/operator/u);
  });

  it("accepts only prefix-preserving depth growth with a tighter unseen bound", () => {
    const previous = sealWithLexical(
      "truncated",
      1,
      0.4,
      [observation("lexical:a", "candidate-a", 1)]
    );
    const refined = sealWithLexical(
      "complete",
      2,
      0,
      [
        observation("lexical:a", "candidate-a", 1),
        observation("lexical:b", "candidate-b", 2)
      ]
    );

    expect(() => assertRecallFiniteFieldRefinement(previous, refined)).not.toThrow();
    expect(() => assertRecallFiniteFieldRefinement(previous, sealWithLexical(
      "truncated",
      2,
      0.5,
      [
        observation("lexical:a", "candidate-a", 1),
        observation("lexical:b", "candidate-b", 2)
      ]
    ))).toThrow(/unseen/u);
    expect(() => assertRecallFiniteFieldRefinement(previous, sealWithLexical(
      "complete",
      2,
      0,
      [
        observation("lexical:changed", "candidate-a", 1),
        observation("lexical:b", "candidate-b", 2)
      ]
    ))).toThrow(/prefix/u);
  });

  it("requires complete channels to prove a zero unseen bound", () => {
    expect(() => sealWithLexical("complete", 1, 0.1, [
      observation("lexical:a", "candidate-a", 1)
    ])).toThrow(/complete/u);
  });
});

describe("fixed-denominator family rank base", () => {
  it("does not renormalize when the semantic channel is absent", () => {
    const unavailable = fixedBase(sealWithStatuses("unavailable", false));
    const ineligible = fixedBase(sealWithStatuses("ineligible", false));

    expect(unavailable.score).toBeCloseTo(0.25, 12);
    expect(ineligible.score).toBe(unavailable.score);
    expect(unavailable.denominator).toBe(2);
    expect(unavailable.configuration_digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(unavailable.channel_responses[0]).toMatchObject({
      channel_id: "semantic",
      status: "unavailable",
      kappa: 1,
      rank: null,
      response: 0
    });
  });

  it("lets correlated channels cast one family-max ballot", () => {
    const oneLexicalView = fixedBase(sealWithStatuses("unavailable", false));
    const twoLexicalViews = fixedBase(sealWithStatuses("unavailable", true));

    expect(twoLexicalViews.score).toBe(oneLexicalView.score);
    expect(twoLexicalViews.family_ballots.find(({ family_id }) =>
      family_id === "lexical")?.response).toBeCloseTo(0.5, 12);
  });

  it("canonicalizes equivalent family and channel input permutations", () => {
    const seal = sealWithStatuses("unavailable", true);
    const forward = fixedBase(seal);
    const reversed = computeFixedFamilyRankBase({
      candidate_key: "candidate-a",
      seal,
      families: [
        {
          family_id: "lexical",
          weight: 1,
          channels: [
            { channel_id: "lexical_trigram", kappa: 1 },
            { channel_id: "lexical_exact", kappa: 1 }
          ]
        },
        {
          family_id: "semantic",
          weight: 1,
          channels: [{ channel_id: "semantic", kappa: 1 }]
        }
      ]
    });

    expect(reversed.configuration_digest).toBe(forward.configuration_digest);
    expect(reversed.family_ballots).toEqual(forward.family_ballots);
    expect(reversed.score).toBe(forward.score);
  });

  it("propagates family-max unseen bounds through the fixed denominator", () => {
    const seal = createRecallFiniteFieldSeal({
      channel_catalog: ["semantic", "lexical_exact", "lexical_trigram"],
      upstream_snapshot_digest: SNAPSHOT,
      channels: [
        channel("semantic", "truncated", 1, 0.2, []),
        channel("lexical_exact", "truncated", 1, 0.1, []),
        channel("lexical_trigram", "complete", 0, 0, [])
      ]
    });

    expect(fixedBase(seal).best_unseen_score_upper_bound).toBeCloseTo(0.15, 12);
  });
});

function fixedBase(
  seal: ReturnType<typeof createRecallFiniteFieldSeal>
) {
  return computeFixedFamilyRankBase({
    candidate_key: "candidate-a",
    seal,
    families: [
      {
        family_id: "semantic",
        weight: 1,
        channels: [{ channel_id: "semantic", kappa: 1 }]
      },
      {
        family_id: "lexical",
        weight: 1,
        channels: [
          { channel_id: "lexical_exact", kappa: 1 },
          { channel_id: "lexical_trigram", kappa: 1 }
        ]
      }
    ]
  });
}

function sealWithStatuses(
  semanticStatus: "unavailable" | "ineligible",
  includeTrigram: boolean
) {
  return createRecallFiniteFieldSeal({
    channel_catalog: ["semantic", "lexical_exact", "lexical_trigram"],
    upstream_snapshot_digest: SNAPSHOT,
    channels: [
      channel("semantic", semanticStatus, 0, null, []),
      channel("lexical_exact", "complete", 1, 0, [
        observation("exact:a", "candidate-a", 1)
      ]),
      channel(
        "lexical_trigram",
        "complete",
        includeTrigram ? 1 : 0,
        0,
        includeTrigram ? [observation("trigram:a", "candidate-a", 1)] : []
      )
    ]
  });
}

function sealWithLexical(
  status: "complete" | "truncated",
  depth: number,
  unseenUpperBound: number,
  observations: readonly ReturnType<typeof observation>[]
) {
  return createRecallFiniteFieldSeal({
    channel_catalog: ["lexical"],
    upstream_snapshot_digest: SNAPSHOT,
    channels: [channel("lexical", status, depth, unseenUpperBound, observations)]
  });
}

function channel(
  channel_id: string,
  status: "complete" | "truncated" | "unavailable" | "ineligible",
  depth: number,
  unseen_upper_bound: number | null,
  observations: readonly ReturnType<typeof observation>[]
) {
  return { channel_id, status, depth, unseen_upper_bound, observations } as const;
}

function observation(observation_id: string, candidate_key: string, rank: number) {
  return { observation_id, candidate_key, rank } as const;
}
