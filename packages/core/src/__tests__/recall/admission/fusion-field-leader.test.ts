import { describe, expect, it } from "vitest";
import { retainUniqueFusionFieldLeader } from
  "../../../recall/delivery/admission/answer-head/fusion-field-leader.js";
import { createRankedCandidate } from "../fine-assessment-selection-fixtures.js";

describe("unique fusion field leader", () => {
  it("moves a unique fusion field leader into the fifth slot", () => {
    const candidates = Array.from({ length: 7 }, (_, index) =>
      ranked(`candidate-${index + 1}`, index + 2, index + 2));
    const leader = ranked("fusion-leader", 1, 4);
    const ordered = [...candidates, leader];
    const result = retainUniqueFusionFieldLeader({
      selection: selection(ordered),
      maxEntries: 5,
      selectDelivered: (rows) => rows.slice(0, 7),
      keyOf: (candidate) => candidate.fusion.candidate_key
    });

    expect(result.candidates[4]?.entry.object_id).toBe("fusion-leader");
    expect(result.protections).toEqual([{
      candidateKey: leader.fusion.candidate_key,
      rankLimit: 5
    }]);
  });

  it("still retains a unique fusion leader when lexical rank 1 is tied", () => {
    const candidates = Array.from({ length: 7 }, (_, index) =>
      ranked(`candidate-${index + 1}`, index + 2, index === 0 ? 1 : index + 2));
    const leader = ranked("fusion-leader", 1, 1);
    const ordered = [...candidates, leader];
    const result = retainUniqueFusionFieldLeader({
      selection: selection(ordered),
      maxEntries: 5,
      selectDelivered: (rows) => rows.slice(0, 7),
      keyOf: (candidate) => candidate.fusion.candidate_key
    });

    expect(result.candidates[4]?.entry.object_id).toBe("fusion-leader");
    expect(result.protections).toEqual([{
      candidateKey: leader.fusion.candidate_key,
      rankLimit: 5
    }]);
  });

  it("is a no-op when the delivered head is narrower than five", () => {
    const protectedEvidence = ranked("evidence", 2, 2);
    const leader = ranked("fusion-leader", 1, 4);
    const ordered = [protectedEvidence, leader];
    const input = Object.freeze({
      candidates: ordered,
      protections: Object.freeze([{
        candidateKey: protectedEvidence.fusion.candidate_key,
        rankLimit: 1
      }]),
      rejectedCandidateKeys: Object.freeze([])
    });
    expect(retainUniqueFusionFieldLeader({
      selection: input,
      maxEntries: 1,
      selectDelivered: (rows) => rows.slice(0, 1),
      keyOf: (candidate) => candidate.fusion.candidate_key
    })).toEqual(input);
  });

  it("displaces an unprotected fifth slot while keeping a protected first slot", () => {
    const protectedEvidence = ranked("evidence", 2, 2);
    const others = Array.from({ length: 6 }, (_, index) =>
      ranked(`candidate-${index + 1}`, index + 3, index + 3));
    const leader = ranked("fusion-leader", 1, 4);
    const ordered = [protectedEvidence, ...others, leader];
    const result = retainUniqueFusionFieldLeader({
      selection: Object.freeze({
        candidates: ordered,
        protections: Object.freeze([{
          candidateKey: protectedEvidence.fusion.candidate_key,
          rankLimit: 5
        }]),
        rejectedCandidateKeys: Object.freeze([])
      }),
      maxEntries: 5,
      selectDelivered: (rows) => rows.slice(0, 7),
      keyOf: (candidate) => candidate.fusion.candidate_key
    });

    expect(result.candidates[0]?.entry.object_id).toBe("evidence");
    expect(result.candidates[4]?.entry.object_id).toBe("fusion-leader");
  });

  it("does not invent a leader when fused rank 1 is tied", () => {
    const tied = [
      ranked("fusion-a", 1, 2),
      ranked("fusion-b", 1, 3),
      ...Array.from({ length: 4 }, (_, index) =>
        ranked(`other-${index + 1}`, index + 3, index + 4))
    ];
    expect(retainUniqueFusionFieldLeader({
      selection: selection(tied),
      maxEntries: 5,
      selectDelivered: (rows) => rows.slice(0, 6),
      keyOf: (candidate) => candidate.fusion.candidate_key
    })).toEqual(selection(tied));
  });
});

function ranked(objectId: string, fusedRank: number, lexicalRank: number) {
  const candidate = createRankedCandidate(objectId, fusedRank, 1 / fusedRank);
  return {
    ...candidate,
    fusion: {
      ...candidate.fusion,
      per_stream_rank: {
        ...candidate.fusion.per_stream_rank,
        lexical_fts: lexicalRank
      }
    }
  };
}

function selection(candidates: readonly ReturnType<typeof ranked>[]) {
  return Object.freeze({
    candidates,
    protections: Object.freeze([]),
    rejectedCandidateKeys: Object.freeze([])
  });
}
