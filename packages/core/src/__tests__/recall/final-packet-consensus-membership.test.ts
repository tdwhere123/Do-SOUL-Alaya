import { describe, expect, it } from "vitest";
import {
  buildFinalPacketConsensusObservation,
  resolveFinalPacketConsensusPlan
} from
  "../../recall/delivery/final-order/final-packet-consensus.js";
import { assertRecallPacketPlanObservation } from
  "../../recall/delivery/packet-plan/packet-plan-observation.js";
import { compileRecallQueryProbes } from
  "../../recall/query/recall-query-probes.js";
import {
  baselineCandidates,
  consensusCandidates,
  select,
  withStreamRanks
} from "./final-strict-tail-consensus-fixtures.js";

describe("final packet consensus membership", () => {
  it.each([6, 7, 8, 9, 10])(
    "governs the actual Top-5 boundary for a %i-item packet",
    (packetSize) => {
      const original = baselineCandidates().slice(0, packetSize);
      const baseline = select(original).candidates;
      const opportunityId = baseline[5]!.object_id;
      const sourceCandidates = original.map((candidate) =>
        candidate.entry.object_id === opportunityId
          ? withStreamRanks(candidate, {
              lexical_fts: 1,
              source_proximity: 1,
              source_evidence_agreement: 1
            })
          : candidate
      );

      const plan = resolveFinalPacketConsensusPlan({
        baseline,
        sourceCandidates,
        protectedCandidates: [],
        behaviorGuardFullAbort: false,
        membershipGovernance: {
          preProjection: baseline,
          queryProbes: compileRecallQueryProbes(null),
          behaviorAuthorityEvidenceRefByCandidateKey: new Map()
        }
      });

      expect(plan.headWidth).toBe(5);
      expect(plan.candidates.slice(0, 5).map((candidate) =>
        candidate.sourceCandidate.entry.object_id
      )).toContain(opportunityId);
      expect(plan.decision).toEqual({
        status: "accepted",
        reason: "nested_membership_consensus"
      });
    }
  );

  it("freezes a behavior member without aborting unrelated safe membership", () => {
    const original = baselineCandidates().slice(0, 6).map((candidate, index) =>
      index === 0
        ? Object.freeze({
            ...candidate,
            entry: Object.freeze({
              ...candidate.entry,
              evidence_refs: Object.freeze(["evidence:verified-behavior"])
            })
          })
        : candidate
    );
    const baseline = select(original).candidates;
    const behaviorKey = original[0]!.fusion.candidate_key;
    const opportunityId = baseline[5]!.object_id;
    const sourceCandidates = original.map((candidate) =>
      candidate.entry.object_id === opportunityId
        ? withStreamRanks(candidate, {
            lexical_fts: 1,
            source_proximity: 1,
            source_evidence_agreement: 1
          })
        : candidate
    );

    const plan = resolveFinalPacketConsensusPlan({
      baseline,
      sourceCandidates,
      protectedCandidates: [],
      behaviorGuardFullAbort: true,
      membershipGovernance: {
        preProjection: baseline,
        queryProbes: compileRecallQueryProbes(null),
        behaviorAuthorityEvidenceRefByCandidateKey: new Map([[
          behaviorKey,
          original[0]!.entry.evidence_refs[0]!
        ]])
      }
    });

    expect(plan.candidates.slice(0, 5).map((candidate) =>
      candidate.candidateKey
    )).toContain(behaviorKey);
    expect(plan.candidates.slice(0, 5).map((candidate) =>
      candidate.sourceCandidate.entry.object_id
    )).toContain(opportunityId);
  });

  it("does not project a partial head as the Top-5 membership boundary", () => {
    const sourceCandidates = baselineCandidates().slice(0, 3).map(
      (candidate, index) => withStreamRanks(candidate, {
        lexical_fts: index + 1,
        source_proximity: index + 1,
        source_evidence_agreement: index + 1
      })
    );
    const baseline = select(sourceCandidates, {
      maxEntries: 3,
      finalOrderAfterCoverage: "public_relevance"
    }).candidates;

    const plan = resolveFinalPacketConsensusPlan({
      baseline,
      sourceCandidates,
      protectedCandidates: [],
      behaviorGuardFullAbort: false,
      membershipGovernance: {
        preProjection: [...baseline].reverse(),
        queryProbes: compileRecallQueryProbes(null),
        behaviorAuthorityEvidenceRefByCandidateKey: new Map()
      }
    });

    expect(plan.headWidth).toBe(2);
    expect(plan.candidates.map((candidate) =>
      candidate.sourceCandidate.entry.object_id
    )).toEqual(baseline.map((candidate) => candidate.object_id));
  });

  it("returns the exact baseline when membership is infeasible", () => {
    const baseline = select(baselineCandidates()).candidates;
    const sourceCandidates = consensusCandidates().map((candidate, index) => {
      if (index < 5) {
        return withStreamRanks(candidate, { lexical_fts: index + 1 });
      }
      if (candidate.entry.object_id === "baseline-06") {
        return withStreamRanks(candidate, {
          lexical_fts: 1,
          source_proximity: 1,
          source_evidence_agreement: 1
        });
      }
      return candidate;
    });

    const plan = resolveFinalPacketConsensusPlan({
      baseline,
      sourceCandidates,
      protectedCandidates: [],
      behaviorGuardFullAbort: false,
      membershipGovernance: {
        preProjection: baseline,
        queryProbes: compileRecallQueryProbes(null),
        behaviorAuthorityEvidenceRefByCandidateKey: new Map()
      }
    });

    expect(plan.decision).toEqual({
      status: "no_op",
      reason: "unchanged_consensus"
    });
    expect(plan.candidates.map((candidate) =>
      candidate.sourceCandidate.entry.object_id
    )).toEqual(baseline.map((candidate) => candidate.object_id));
  });

  it("lets the final selector consume finite embedding ranks", () => {
    const sourceCandidates = consensusCandidates();
    const baseline = select(baselineCandidates()).candidates;

    const plan = resolveFinalPacketConsensusPlan({
      baseline,
      sourceCandidates,
      protectedCandidates: [],
      behaviorGuardFullAbort: false
    });

    expect(plan.embeddingHead.length).toBeGreaterThan(0);
    expect(plan.decision).toEqual({
      status: "accepted",
      reason: "strict_tail_consensus"
    });
    expect(plan.candidates.slice(0, plan.headWidth).map((candidate) =>
      candidate.sourceCandidate.entry.object_id
    )).toContain("challenger");
  });

  it("fails closed when no membership authority is available", () => {
    const baseline = select(baselineCandidates()).candidates;
    const plan = resolveFinalPacketConsensusPlan({
      baseline,
      sourceCandidates: consensusCandidates(),
      protectedCandidates: [],
      behaviorGuardFullAbort: true
    });
    const observation = buildFinalPacketConsensusObservation(plan, baseline, false);

    expect(observation.decision).toEqual({
      status: "rejected",
      reason: "behavior_guard_full_abort"
    });
    expect(observation.planned_candidate_keys).not.toEqual(
      observation.actual_candidate_keys
    );
    expect(observation.actual_candidate_keys).toEqual(
      observation.baseline_candidate_keys
    );
    expect(() => assertRecallPacketPlanObservation(observation))
      .not.toThrow();
  });
});
