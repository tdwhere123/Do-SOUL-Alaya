import { describe, expect, it } from "vitest";
import {
  buildFinalPacketConsensusObservation,
  resolveFinalPacketConsensusPlan
} from
  "../../recall/delivery/final-order/final-packet-consensus.js";
import { assertRecallPacketPlanObservation } from
  "../../recall/delivery/packet-plan/packet-plan-observation.js";
import { applyLexicographicNestedMembership } from
  "../../recall/delivery/nested-selector/nested-consensus-projection.js";
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

  it("lets selector consensus resolve an ordinary direct-evidence conflict", () => {
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
      membershipGovernance: {
        preProjection: baseline,
        queryProbes: compileRecallQueryProbes(null),
        behaviorAuthorityEvidenceRefByCandidateKey: new Map()
      }
    });

    expect(plan.decision).toEqual({
      status: "accepted",
      reason: "nested_membership_consensus"
    });
    expect(plan.membershipAuthorizations.some((authorization) =>
      authorization.kind === "selector_consensus"
    )).toBe(true);
  });

  it("lets the final selector consume finite embedding ranks", () => {
    const sourceCandidates = consensusCandidates();
    const baseline = select(baselineCandidates()).candidates;

    const plan = resolveFinalPacketConsensusPlan({
      baseline,
      sourceCandidates,
      protectedCandidates: []
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

  it("keeps an embedding-selected member when direct protections are present", () => {
    const baseline = select(baselineCandidates()).candidates;
    const sourceCandidates = consensusCandidates().map((candidate) =>
      candidate.entry.object_id === "baseline-01"
        ? withStreamRanks(candidate, { lexical_fts: 1 })
        : candidate
    );

    const plan = resolveFinalPacketConsensusPlan({
      baseline,
      sourceCandidates,
      protectedCandidates: [],
      membershipGovernance: {
        preProjection: baseline,
        queryProbes: compileRecallQueryProbes("what was recorded?"),
        behaviorAuthorityEvidenceRefByCandidateKey: new Map()
      }
    });

    expect(plan.decision).toEqual({
      status: "accepted",
      reason: "nested_membership_consensus"
    });
    expect(plan.candidates.slice(0, 5).map((candidate) =>
      candidate.sourceCandidate.entry.object_id
    )).toContain("challenger");
    expect(plan.membershipAuthorizations.some((authorization) =>
      authorization.kind === "selector_consensus"
    )).toBe(true);
  });

  it("fails closed when no membership authority is available", () => {
    const baseline = select(baselineCandidates()).candidates;
    const plan = resolveFinalPacketConsensusPlan({
      baseline,
      sourceCandidates: consensusCandidates(),
      protectedCandidates: []
    });
    const observation = buildFinalPacketConsensusObservation(plan, baseline, false);

    expect(observation.decision).toEqual({
      status: "rejected",
      reason: "admission_infeasible"
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

  it("reissues membership receipts after a nested selector exchange", () => {
    const baseline = select(baselineCandidates()).candidates;
    const sourceCandidates = consensusCandidates().map((candidate) =>
      candidate.entry.object_id === "baseline-06"
        ? withStreamRanks(candidate, {
            lexical_fts: 1,
            source_proximity: 1,
            source_evidence_agreement: 1
          })
        : candidate
    );
    const incumbent = resolveFinalPacketConsensusPlan({
      baseline, sourceCandidates, protectedCandidates: []
    });
    const introducedKey = sourceCandidates.find((candidate) =>
      candidate.entry.object_id === "baseline-06"
    )!.fusion.candidate_key;
    const headKeys = [
      ...incumbent.candidates.slice(0, 4).map(({ candidateKey }) => candidateKey),
      introducedKey
    ];
    const headSet = new Set(headKeys);
    const packKeys = [
      ...headKeys,
      ...incumbent.candidates
        .map(({ candidateKey }) => candidateKey)
        .filter((key) => !headSet.has(key))
    ];

    const plan = applyLexicographicNestedMembership({
      plan: incumbent,
      sourceCandidates,
      headKeys,
      packKeys,
      membershipGovernance: {
        preProjection: baseline,
        queryProbes: compileRecallQueryProbes(null),
        behaviorAuthorityEvidenceRefByCandidateKey: new Map()
      }
    });

    expect(plan.consensusHead.map(({ candidateKey }) => candidateKey))
      .toContain(introducedKey);
    expect(plan.membershipAuthorizations.map(({ satisfiedByCandidateKey }) =>
      satisfiedByCandidateKey
    )).toContain(introducedKey);
    expect(() => buildFinalPacketConsensusObservation(plan, baseline, false))
      .not.toThrow();
  });

  it("does not let set selection reorder retained head members", () => {
    const baseline = select(baselineCandidates()).candidates;
    const sourceCandidates = consensusCandidates().map((candidate) =>
      candidate.entry.object_id === "baseline-06"
        ? withStreamRanks(candidate, {
            lexical_fts: 1,
            source_proximity: 1,
            source_evidence_agreement: 1
          })
        : candidate
    );
    const incumbent = resolveFinalPacketConsensusPlan({
      baseline, sourceCandidates, protectedCandidates: []
    });
    const byId = new Map(sourceCandidates.map((candidate) => [
      candidate.entry.object_id, candidate.fusion.candidate_key
    ]));
    const headKeys = [
      byId.get("baseline-05")!,
      byId.get("baseline-04")!,
      byId.get("baseline-02")!,
      byId.get("baseline-01")!,
      byId.get("baseline-06")!
    ];
    const headSet = new Set(headKeys);
    const packKeys = [
      ...headKeys,
      ...incumbent.candidates
        .map(({ candidateKey }) => candidateKey)
        .filter((key) => !headSet.has(key))
    ].slice(0, incumbent.candidates.length);

    const plan = applyLexicographicNestedMembership({
      plan: incumbent,
      sourceCandidates,
      headKeys,
      packKeys,
      membershipGovernance: {
        preProjection: baseline,
        queryProbes: compileRecallQueryProbes(null),
        behaviorAuthorityEvidenceRefByCandidateKey: new Map()
      }
    });

    const finalIds = plan.consensusHead.map(({ sourceCandidate }) =>
      sourceCandidate.entry.object_id
    );
    expect(finalIds.filter((id) => id !== "baseline-06")).toEqual([
      "baseline-01",
      "baseline-02",
      "baseline-04",
      "baseline-05"
    ]);
    expect(finalIds).toContain("baseline-06");
    expect(() => buildFinalPacketConsensusObservation(plan, baseline, false))
      .not.toThrow();
  });

  it("restores the incumbent when a nested introduction lacks authority", () => {
    const baseline = select(baselineCandidates()).candidates;
    const sourceCandidates = consensusCandidates();
    const incumbent = resolveFinalPacketConsensusPlan({
      baseline, sourceCandidates, protectedCandidates: []
    });
    const byId = new Map(sourceCandidates.map((candidate) => [
      candidate.entry.object_id, candidate.fusion.candidate_key
    ]));
    const headKeys = [
      byId.get("baseline-01")!,
      byId.get("baseline-02")!,
      byId.get("baseline-04")!,
      byId.get("baseline-05")!,
      byId.get("baseline-06")!
    ];
    const headSet = new Set(headKeys);
    const packKeys = [
      ...headKeys,
      ...incumbent.candidates
        .map(({ candidateKey }) => candidateKey)
        .filter((key) => !headSet.has(key))
    ].slice(0, incumbent.candidates.length);

    const plan = applyLexicographicNestedMembership({
      plan: incumbent,
      sourceCandidates,
      headKeys,
      packKeys,
      membershipGovernance: {
        preProjection: baseline,
        queryProbes: compileRecallQueryProbes(null),
        behaviorAuthorityEvidenceRefByCandidateKey: new Map()
      }
    });

    expect(plan).toBe(incumbent);
    expect(() => buildFinalPacketConsensusObservation(plan, baseline, false))
      .not.toThrow();
  });
});
