import { describe, expect, it } from "vitest";
import {
  resolveEmbeddingRankConsensusPlan
} from "../../../recall/delivery/packet-plan/embedding-rank-consensus.js";

describe("embedding-rank consensus packet plan", () => {
  it.each([
    { packetSize: 1, headWidth: 1 },
    { packetSize: 2, headWidth: 1 },
    { packetSize: 9, headWidth: 5 },
    { packetSize: 10, headWidth: 5 }
  ])(
    "derives its head from a $packetSize-entry packet and preserves its tail",
    ({ packetSize, headWidth }) => {
      const baseline = packet(...Array.from(
        { length: packetSize },
        (_, index) => `baseline-${index + 1}`
      ));
      const novel = candidate("novel", 100, 1);

      const planned = plan({
        baseline,
        candidates: [...baseline, novel]
      });

      expect(keys(planned)).toEqual([
        "novel",
        ...keys(baseline.slice(0, headWidth - 1)),
        ...keys(baseline.slice(headWidth))
      ]);
      expect(planned.slice(headWidth)).toEqual(baseline.slice(headWidth));
      for (let index = headWidth; index < baseline.length; index += 1) {
        expect(planned[index]).toBe(baseline[index]);
      }
    }
  );

  it("returns the exact baseline when no eligible finite embedding rank exists", () => {
    const baseline = packet("a", "b", "c");
    const planned = plan({
      baseline,
      candidates: [
        ...baseline,
        candidate("nan", 100, Number.NaN),
        candidate("infinite", 100, Number.POSITIVE_INFINITY),
        candidate("outside-head", 100, 3)
      ]
    });

    expect(planned).toBe(baseline);
  });

  it("promotes a baseline-tail key when the source ranks it first", () => {
    const baseline = packet("head-a", "head-b", "tail");
    const rankedTail = candidate("tail", 100, 1);

    const planned = plan({
      baseline,
      candidates: [...baseline, rankedTail]
    });

    expect(keys(planned)).toEqual(["tail", "head-a", "head-b"]);
    expect(planned).not.toBe(baseline);
  });

  it("clamps the consensus head to the baseline length", () => {
    const baseline = packet("a", "b", "c");
    const planned = plan({
      baseline,
      candidates: [...baseline, candidate("novel", 100, 1)]
    });

    expect(keys(planned)).toEqual(["novel", "a", "c"]);
    expect(planned).toHaveLength(baseline.length);
  });

  it("adds reciprocal baseline-head and embedding ranks for the same key", () => {
    const baseline = Object.freeze([
      candidate("a", 10),
      candidate("b", 0),
      candidate("tail", 0)
    ]);
    const rankedB = candidate("b", 0, 1);

    const planned = plan({
      baseline,
      candidates: [...baseline, rankedB]
    });

    expect(keys(planned)).toEqual(["b", "a", "tail"]);
  });

  it("orders equal reciprocal-rank scores by fused score, then key, independent of input order", () => {
    const baseline = packet(
      "incumbent-a",
      "incumbent-b",
      "incumbent-c",
      "tail-d",
      "tail-e",
      "tail-f"
    );
    const highFused = candidate("novel-z", 9, 2);
    const lexicalFirst = candidate("novel-a", 8, 2);
    const lexicalSecond = candidate("novel-b", 8, 2);
    const expected = [
      "incumbent-a",
      "novel-z",
      "novel-a",
      "tail-d",
      "tail-e",
      "tail-f"
    ];

    for (const ranked of [
      [highFused, lexicalFirst, lexicalSecond],
      [lexicalSecond, highFused, lexicalFirst],
      [lexicalFirst, lexicalSecond, highFused]
    ]) {
      const planned = plan({
        baseline,
        candidates: [...baseline, ...ranked]
      });
      expect(keys(planned)).toEqual(expected);
    }
  });

  it.each([
    {
      name: "drop",
      baseline: packet("head", "protected", "tail"),
      contender: candidate("novel", 100, 1),
      protectedCandidates: [{ candidateKey: "protected", rankLimit: 2 }],
      expected: ["novel", "protected", "tail"]
    },
    {
      name: "rank-limit breach",
      baseline: packet("protected", "head", "tail"),
      contender: candidate("novel", 100, 1),
      protectedCandidates: [{ candidateKey: "protected", rankLimit: 1 }],
      expected: ["protected", "novel", "tail"]
    }
  ])("composes consensus without allowing a protected candidate $name", ({
    baseline,
    contender,
    protectedCandidates,
    expected
  }) => {
    const planned = plan({
      baseline,
      candidates: [...baseline, contender],
      protectedCandidates
    });

    expect(keys(planned)).toEqual(expected);
  });

  it("retains multiple protections with the same bounded rank", () => {
    const baseline = packet(
      "head",
      "protected-a",
      "protected-b",
      "tail-a",
      "tail-b"
    );
    const planned = plan({
      baseline,
      candidates: [
        ...baseline,
        candidate("novel-a", 100, 1),
        candidate("novel-b", 99, 2)
      ],
      protectedCandidates: [
        { candidateKey: "protected-a", rankLimit: 3 },
        { candidateKey: "protected-b", rankLimit: 3 }
      ]
    });

    expect(keys(planned)).toEqual([
      "novel-a",
      "protected-a",
      "protected-b",
      "tail-a",
      "tail-b"
    ]);
  });

  it("reports an absent embedding proposal as a no-op", () => {
    const baseline = packet("a", "b", "tail");
    const resolved = resolve({
      baseline,
      candidates: baseline
    });

    expect(resolved.candidates).toBe(baseline);
    expect(resolved.decision).toEqual({
      status: "no_op",
      reason: "no_finite_embedding_head"
    });
  });

  it("resolves truthful frozen metadata for an accepted consensus", () => {
    const baseline = packet("a", "b", "c", "tail-d", "tail-e", "tail-f");
    const novel = candidate("novel", 9, 2);
    const protection = { candidateKey: "a", rankLimit: 1 };
    const resolved = resolve({
      baseline,
      candidates: [...baseline, novel],
      protectedCandidates: [protection]
    });

    expect(resolved.baseline).toBe(baseline);
    expect(resolved.proposedCandidates).toBe(resolved.candidates);
    expect(resolved.headWidth).toBe(3);
    expect(keys(resolved.baselineHead)).toEqual(["a", "b", "c"]);
    expect(resolved.embeddingHead).toEqual([
      { candidate: novel, embeddingRank: 2 }
    ]);
    expect(keys(resolved.consensusHead)).toEqual(["a", "novel", "b"]);
    expect(keys(resolved.immutableTail)).toEqual(["tail-d", "tail-e", "tail-f"]);
    expect(resolved.protectedCandidates).toEqual([protection]);
    expect(keys(resolved.candidates)).toEqual([
      "a",
      "novel",
      "b",
      "tail-d",
      "tail-e",
      "tail-f"
    ]);
    expect(resolved.decision).toEqual({
      status: "accepted",
      reason: "strict_tail_consensus"
    });

    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.proposedCandidates)).toBe(true);
    expect(Object.isFrozen(resolved.candidates)).toBe(true);
    expect(Object.isFrozen(resolved.baselineHead)).toBe(true);
    expect(Object.isFrozen(resolved.embeddingHead)).toBe(true);
    expect(Object.isFrozen(resolved.embeddingHead[0])).toBe(true);
    expect(Object.isFrozen(resolved.consensusHead)).toBe(true);
    expect(Object.isFrozen(resolved.immutableTail)).toBe(true);
    expect(Object.isFrozen(resolved.protectedCandidates)).toBe(true);
    expect(Object.isFrozen(resolved.protectedCandidates[0])).toBe(true);
    expect(Object.isFrozen(resolved.decision)).toBe(true);
  });

  it("reports no finite embedding head as a no-op", () => {
    const baseline = packet("a", "b", "tail");
    const resolved = resolve({
      baseline,
      candidates: [
        ...baseline,
        candidate("nan", 9, Number.NaN),
        candidate("outside", 9, 3)
      ]
    });

    expect(resolved.candidates).toBe(baseline);
    expect(resolved.embeddingHead).toEqual([]);
    expect(keys(resolved.consensusHead)).toEqual(["a", "b"]);
    expect(resolved.decision).toEqual({
      status: "no_op",
      reason: "no_finite_embedding_head"
    });
  });

  it("distinguishes an unchanged finite consensus from an absent head", () => {
    const baseline = packet("a", "b", "tail");
    const rankedA = candidate("a", 0, 1);
    const resolved = resolve({
      baseline,
      candidates: [...baseline, rankedA]
    });

    expect(resolved.candidates).toBe(baseline);
    expect(resolved.embeddingHead).toEqual([
      { candidate: rankedA, embeddingRank: 1 }
    ]);
    expect(keys(resolved.consensusHead)).toEqual(["a", "b"]);
    expect(resolved.decision).toEqual({
      status: "no_op",
      reason: "unchanged_consensus"
    });
  });

  it("distinguishes infeasible protection and cardinality rejections", () => {
    const protectedBaseline = packet("head", "protected", "tail");
    const protectedPlan = resolve({
      baseline: protectedBaseline,
      candidates: [
        ...protectedBaseline,
        candidate("novel", 100, 1)
      ],
      protectedCandidates: [{ candidateKey: "absent", rankLimit: 2 }]
    });
    expect(protectedPlan.candidates).toBe(protectedBaseline);
    expect(protectedPlan.decision).toEqual({
      status: "rejected",
      reason: "protected_candidate_constraint"
    });

    const duplicate = candidate("duplicate");
    const duplicateBaseline = Object.freeze([
      duplicate,
      duplicate,
      candidate("tail")
    ]);
    const cardinalityPlan = resolve({
      baseline: duplicateBaseline,
      candidates: [
        ...duplicateBaseline,
        candidate("duplicate", 0, 1)
      ]
    });
    expect(cardinalityPlan.candidates).toBe(duplicateBaseline);
    expect(cardinalityPlan.consensusHead).toHaveLength(1);
    expect(cardinalityPlan.decision).toEqual({
      status: "rejected",
      reason: "cardinality_mismatch"
    });
  });

  it("keeps a rejected proposal partition distinct from the applied baseline", () => {
    const baseline = packet("head-a", "head-b", "tail");
    const resolved = resolve({
      baseline,
      candidates: [
        ...baseline,
        candidate("tail", 100, 1)
      ],
      protectedCandidates: [{ candidateKey: "absent", rankLimit: 2 }]
    });
    const proposedKeys = [
      ...keys(resolved.consensusHead),
      ...keys(resolved.immutableTail)
    ];

    expect(resolved.candidates).toBe(baseline);
    expect(resolved.decision).toEqual({
      status: "rejected",
      reason: "protected_candidate_constraint"
    });
    expect(keys(resolved.proposedCandidates)).toEqual(proposedKeys);
    expect(proposedKeys).toEqual(["tail", "head-a", "head-b"]);
    expect(new Set(proposedKeys)).toHaveLength(proposedKeys.length);
  });
});

type Candidate = Readonly<{
  candidateKey: string;
  fusedScore: number;
  rawEmbeddingRank?: number;
}>;

type Protection = Readonly<{
  candidateKey: string;
  rankLimit: number;
}>;

function candidate(
  candidateKey: string,
  fusedScore = 0,
  rawEmbeddingRank?: number
): Candidate {
  return Object.freeze({
    candidateKey,
    fusedScore,
    ...(rawEmbeddingRank === undefined ? {} : { rawEmbeddingRank })
  });
}

function packet(...candidateKeys: string[]): readonly Candidate[] {
  return Object.freeze(candidateKeys.map((key, index) => candidate(key, -index)));
}

function plan(params: {
  baseline: readonly Candidate[];
  candidates: readonly Candidate[];
  protectedCandidates?: readonly Protection[];
}): readonly Candidate[] {
  return resolveEmbeddingRankConsensusPlan({
    baseline: params.baseline,
    candidates: params.candidates,
    protectedCandidates: params.protectedCandidates ?? []
  }).candidates;
}

function resolve(params: {
  baseline: readonly Candidate[];
  candidates: readonly Candidate[];
  protectedCandidates?: readonly Protection[];
}) {
  return resolveEmbeddingRankConsensusPlan({
    baseline: params.baseline,
    candidates: params.candidates,
    protectedCandidates: params.protectedCandidates ?? []
  });
}

function keys(candidates: readonly Candidate[]): string[] {
  return candidates.map((item) => item.candidateKey);
}
