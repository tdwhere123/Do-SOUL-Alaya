import { describe, expect, it } from "vitest";

import {
  assertRecallFiniteFieldRefinement,
  createRecallFiniteFieldSeal,
  verifyRecallFiniteFieldSeal
} from "../../../recall/field/finite-field-seal.js";

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
