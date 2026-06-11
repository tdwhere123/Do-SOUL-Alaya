import { PathGovernanceClass } from "@do-soul/alaya-protocol";
import { type SignalRefSeedSpec } from "./contracts.js";

// invariant: the signal-ref seed table, keyed by producer trust. These
// are agent-asserted refs on a candidate signal — the agent (or a local
// heuristic) claims the relation, so every family seeds attention_only.
// Recall eligibility is decided by recall_bias SIGN, not by
// governance_class:
//   - positive families (derives_from, recall_bias > 0) are recall-eligible
//     at birth even at attention_only — governance_class only adds the
//     +0.15 boost in scorePathRelationExpansion, it is NOT a binary recall
//     gate;
//   - negative families (supersedes / contradicts / incompatible_with,
//     recall_bias < 0) are excluded from positive expansion by their sign,
//     not by plasticity — they record suppression and only contribute once
//     a sign-aware recall pass exists;
//   - the recall-neutral exception_to marker (recall_bias == 0) is excluded
//     from positive expansion by isPathRecallEligible's strict-positive
//     gate.
// attention_only here is the trust floor: it withholds the recall_allowed
// expansion boost and the higher 0.9 strength reserved for the core seed
// profiles. recall_allowed/0.9 negatives are produced ONLY by
// ConflictDetectionService's LLM-verdict path (the system computed the
// verdict); its Jaccard rule path now also seeds attention_only because
// rule-hit conditions are agent-controllable content.
// governanceClass is further clamped to the auto-build ceiling by
// submitCandidate downstream.
// see also: packages/core/src/path-graph/path-relation-proposal-service.ts seed profiles.
// see also: packages/core/src/conflict-detection-service.ts — LLM-verdict negatives.
// see also: packages/protocol/src/soul/path-relation.ts isPathRecallEligible.
// see also: signal-ref-seed-parity.test.ts — pins this live table.
const AGENT_ASSERTED_NEGATIVE_SEED_STRENGTH = 0.5;

export const SIGNAL_REF_SEED_SPECS: readonly SignalRefSeedSpec[] = [
  {
    signalRefsKey: "source_memory_refs",
    relationKind: "derives_from",
    initialStrength: 0.5,
    governanceClass: PathGovernanceClass.ATTENTION_ONLY,
    recallBiasSign: 1,
    recallBiasMagnitude: 0.5,
    evidenceBasis: ["llm_derives_inference"]
  },
  {
    signalRefsKey: "supersedes_refs",
    relationKind: "supersedes",
    initialStrength: AGENT_ASSERTED_NEGATIVE_SEED_STRENGTH,
    governanceClass: PathGovernanceClass.ATTENTION_ONLY,
    recallBiasSign: -1,
    recallBiasMagnitude: 0.5,
    evidenceBasis: ["supersession_evidence"]
  },
  {
    signalRefsKey: "exception_to_refs",
    relationKind: "exception_to",
    initialStrength: 0.9,
    // invariant: agent-asserted exception_to refs seed attention_only, not
    // recall_allowed. The ref is attacker-controllable, so it must not be
    // born recall-eligible-governance; it earns governance through
    // plasticity like the other agent-asserted families. recallBiasSign 0 /
    // magnitude 0 keep the recall-neutral marker semantics.
    governanceClass: PathGovernanceClass.ATTENTION_ONLY,
    recallBiasSign: 0,
    recallBiasMagnitude: 0,
    evidenceBasis: ["exception_evidence"]
  },
  {
    signalRefsKey: "contradicts_refs",
    relationKind: "contradicts",
    initialStrength: AGENT_ASSERTED_NEGATIVE_SEED_STRENGTH,
    governanceClass: PathGovernanceClass.ATTENTION_ONLY,
    recallBiasSign: -1,
    recallBiasMagnitude: 0.4,
    evidenceBasis: ["contradiction_evidence"]
  },
  {
    signalRefsKey: "incompatible_with_refs",
    relationKind: "incompatible_with",
    initialStrength: AGENT_ASSERTED_NEGATIVE_SEED_STRENGTH,
    governanceClass: PathGovernanceClass.ATTENTION_ONLY,
    recallBiasSign: -1,
    recallBiasMagnitude: 0.3,
    evidenceBasis: ["incompatibility_evidence"]
  }
];
