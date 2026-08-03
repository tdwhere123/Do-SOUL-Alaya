import { describe, expect, it } from "vitest";
import { resolveFinalPacketConsensusPlan } from
  "../../recall/delivery/final-order/final-packet-consensus.js";
import { compileRecallQueryProbes } from
  "../../recall/query/recall-query-probes.js";
import {
  baselineCandidates,
  baselineIds,
  consensusCandidates,
  packetIds,
  select,
  withStreamRanks
} from "./final-strict-tail-consensus-fixtures.js";

describe("final packet consensus selection ownership", () => {
  it("does not let a channel-specific membership proposal replace final consensus", () => {
    const original = baselineCandidates().slice(0, 6);
    const baseline = original;
    const opportunityId = baseline[5]!.entry.object_id;
    const sourceCandidates = original.map((candidate) =>
      candidate.entry.object_id === opportunityId
        ? withStreamRanks(candidate, {
            lexical_fts: 1,
            source_proximity: 1,
            source_evidence_agreement: 1
          })
        : candidate
    );
    const shared = {
      baseline,
      sourceCandidates,
      protectedCandidates: []
    };
    const control = resolveFinalPacketConsensusPlan(shared);
    const withIncidentalMembershipState = resolveFinalPacketConsensusPlan({
      ...shared,
      membershipGovernance: {
        preProjection: baseline,
        queryProbes: compileRecallQueryProbes(null),
        behaviorAuthorityEvidenceRefByCandidateKey: new Map()
      }
    });

    expect(candidateKeys(withIncidentalMembershipState))
      .toEqual(candidateKeys(control));
  });

  it("admits the consensus order through one authoritative selector pass", () => {
    const result = select(consensusCandidates());

    expect(result.candidates.map((candidate) => candidate.object_id))
      .toContain("challenger");
    expect(result.diagnostics.every((candidate) =>
      candidate.admission_attempts.length === 1 &&
      candidate.admission_attempts[0]?.pass === "final_selector"
    )).toBe(true);
    expect(result.diagnostics.find((candidate) => candidate.object_id === "challenger"))
      .toMatchObject({ final_rank: expect.any(Number), dropped_reason: null });
  });

  it("falls back before final projection when the consensus packet is infeasible", () => {
    const result = select(consensusCandidates(), {
      capturePacketPlanTrace: true,
      maxTotalTokens: 50,
      tokenByObjectId: { challenger: 10 }
    });

    expect(packetIds(result)).toEqual(baselineIds());
    expect(result.packetPlanObservation?.decision).toEqual({
      status: "rejected",
      reason: "admission_infeasible"
    });
    expect(result.diagnostics.every((candidate) =>
      candidate.admission_attempts.length === 1 &&
      candidate.admission_attempts[0]?.pass === "final_selector"
    )).toBe(true);
  });
});

function candidateKeys(
  plan: ReturnType<typeof resolveFinalPacketConsensusPlan>
): readonly string[] {
  return plan.candidates.map(({ candidateKey }) => candidateKey);
}
