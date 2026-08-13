import { describe, expect, it } from "vitest";
import { retainUniqueFusionFieldLeader } from
  "../../../recall/delivery/admission/answer-head/fusion-field-leader.js";
import { createRankedCandidate } from "../fine-assessment-selection-fixtures.js";

describe("unique fusion field leader", () => {
  it("moves a unique fusion-and-lexical leader into the fifth slot", () => {
    const candidates = Array.from({ length: 7 }, (_, index) =>
      ranked(`candidate-${index + 1}`, index + 2, index + 2));
    const leader = ranked("fusion-lexical-leader", 1, 1);
    const ordered = [...candidates, leader];
    const result = retainUniqueFusionFieldLeader({
      selection: selection(ordered),
      maxEntries: 5,
      selectDelivered: (rows) => rows.slice(0, 7),
      keyOf: (candidate) => candidate.fusion.candidate_key
    });

    expect(result.candidates[4]?.entry.object_id).toBe("fusion-lexical-leader");
    expect(result.protections).toEqual([{
      candidateKey: leader.fusion.candidate_key,
      rankLimit: 5
    }]);
  });

  it("does not promote a fusion leader that is not the unique lexical leader", () => {
    const fusionLeader = ranked("fusion-only", 1, 4);
    const lexicalLeader = ranked("lexical-only", 3, 1);
    const rest = Array.from({ length: 4 }, (_, index) =>
      ranked(`other-${index + 1}`, index + 4, index + 2));
    const ordered = [lexicalLeader, ...rest, fusionLeader];
    const result = retainUniqueFusionFieldLeader({
      selection: selection(ordered),
      maxEntries: 5,
      selectDelivered: (rows) => rows.slice(0, 6),
      keyOf: (candidate) => candidate.fusion.candidate_key
    });

    expect(result).toEqual(selection(ordered));
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
