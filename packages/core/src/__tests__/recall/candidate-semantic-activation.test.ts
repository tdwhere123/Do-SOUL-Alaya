import { describe, expect, it } from "vitest";
import {
  resolveCandidateSemanticActivation,
  type CandidateActivationReceipt
} from "../../recall/scoring/candidate-semantic-activation.js";

describe("candidate activation receipt", () => {
  it("seals an observed winner without exposing an operator-specific scalar contract", () => {
    const receipt = resolveCandidateSemanticActivation({
      scope: "workspace_memory",
      evidenceSemantic: 0.4,
      effectiveEmbedding: 0.7,
      objectEmbedding: 0.6
    });

    expect(receipt).toEqual({
      schema_version: 1,
      operator_id: "candidate_semantic_max_v1",
      state: "observed",
      score: 0.7,
      winner: { channel: "effective_factor", score: 0.7 },
      observations: [
        { channel: "evidence_semantic", state: "observed", score: 0.4 },
        { channel: "effective_factor", state: "observed", score: 0.7 },
        { channel: "object_embedding", state: "observed", score: 0.6 }
      ],
      missing_channel_policy: "no_op"
    });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.observations)).toBe(true);
    expect(Object.isFrozen(receipt.winner)).toBe(true);
  });

  it("distinguishes absent, invalid, and ineligible activation", () => {
    const cases: readonly [string, CandidateActivationReceipt][] = [
      [
        "absent",
        resolveCandidateSemanticActivation({ scope: "workspace_memory" })
      ],
      [
        "invalid",
        resolveCandidateSemanticActivation({
          scope: "workspace_memory",
          effectiveEmbedding: Number.NaN
        })
      ],
      [
        "ineligible",
        resolveCandidateSemanticActivation({ scope: "ineligible" })
      ]
    ];

    expect(cases.map(([, receipt]) => receipt.state)).toEqual([
      "absent",
      "invalid",
      "ineligible"
    ]);
    for (const [, receipt] of cases) {
      expect(receipt.score).toBeNull();
      expect(receipt.winner).toBeNull();
      expect(receipt.missing_channel_policy).toBe("no_op");
    }
  });

  it("keeps a valid channel observed when another channel is invalid", () => {
    const receipt = resolveCandidateSemanticActivation({
      scope: "workspace_memory",
      effectiveEmbedding: Number.NaN,
      objectEmbedding: 0
    });

    expect(receipt.state).toBe("observed");
    expect(receipt.score).toBe(0);
    expect(receipt.winner).toEqual({ channel: "object_embedding", score: 0 });
    expect(receipt.observations).toEqual([
      { channel: "evidence_semantic", state: "absent", score: null },
      { channel: "effective_factor", state: "invalid", score: null },
      { channel: "object_embedding", state: "observed", score: 0 }
    ]);
  });

  it("lets a complete open semantic solution win without an embedding score", () => {
    const receipt = resolveCandidateSemanticActivation({
      scope: "workspace_memory",
      openSemanticSolution: 1
    });

    expect(receipt).toMatchObject({
      state: "observed",
      score: 1,
      winner: { channel: "open_semantic_solution", score: 1 },
      observations: expect.arrayContaining([
        { channel: "open_semantic_solution", state: "observed", score: 1 }
      ])
    });
  });
});
