import { describe, expect, it } from "vitest";
import { resolveFinalPacketConsensusPlan } from
  "../../recall/delivery/final-order/final-packet-consensus.js";
import { compileRecallQueryProbes } from
  "../../recall/query/recall-query-probes.js";
import {
  baselineCandidates,
  select,
  withStreamRanks
} from "./final-strict-tail-consensus-fixtures.js";

describe("final packet consensus selection ownership", () => {
  it("does not let a channel-specific membership proposal replace final consensus", () => {
    const original = baselineCandidates().slice(0, 6);
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
});

function candidateKeys(
  plan: ReturnType<typeof resolveFinalPacketConsensusPlan>
): readonly string[] {
  return plan.candidates.map(({ candidateKey }) => candidateKey);
}
