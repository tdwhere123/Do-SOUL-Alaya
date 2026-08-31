import type { PathMintOutcome, SubmitCandidateInput } from "../edge-proposals/path-relation-proposal-service.js";

// invariant: the single submitCandidate sink contract every folded edge
// producer (EdgeAutoProducer, ConflictDetectionService, and the
// signal-ref router in @do-soul/alaya-soul) depends on. Producers depend
// on this narrow port — not on the whole PathRelationProposalService — so
// they stay unit-testable with a fake while the daemon wires the one real
// PathRelationProposalService.submitCandidate into all of them. Defined
// here (not in path-relation-proposal-service.ts) so the intake module
// stays the seed-profile/materialize owner without gaining a sink-shape
// dependency from its consumers.
// see also: path-relation-proposal-service.ts SubmitCandidateInput — call shape.
// see also: path-relation-proposal-service.ts submitCandidate — the one implementor.
export interface PathCandidateSink {
  // invariant: returns the discriminated PathMintOutcome so a no-drop
  // consumer can keep work pending on "failed" (transient) and settle it
  // on applied / already_present / rejected (permanent). A producer that
  // does not need the distinction may ignore the value.
  // see also: path-relation-proposal-service.ts PathMintOutcome.
  submitCandidate(input: SubmitCandidateInput): Promise<PathMintOutcome>;
}
