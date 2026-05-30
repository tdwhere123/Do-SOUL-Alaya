import type { SubmitCandidateInput } from "./path-relation-proposal-service.js";

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
  submitCandidate(input: SubmitCandidateInput): Promise<boolean>;
}
