import {
  DYNAMICS_CONSTANTS,
  type PathGovernanceClass,
  type PathRelation
} from "@do-soul/alaya-protocol";
import type { EventPublisher } from "../../runtime/event-publisher.js";
import type { PathFailureHealthInboxPort } from "../path-relations/path-failure-health-inbox.js";

export const PATH_RELATION_PROPOSE_THRESHOLD =
  DYNAMICS_CONSTANTS.path_plasticity.co_usage_threshold;
export const PATH_RELATION_COUNTER_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export interface PathSeedProfile {
  readonly relationKind: string;
  readonly initialStrength: number;
  readonly governanceClass: PathGovernanceClass;
  readonly recallBiasSign: 1 | 0 | -1;
  readonly recallBiasMagnitude: number;
  readonly evidenceBasis: readonly string[];
}

export const CO_RECALLED_SEED_PROFILE: PathSeedProfile = Object.freeze({
  relationKind: "co_recalled",
  initialStrength: 0.3,
  governanceClass: "attention_only",
  recallBiasSign: 1,
  recallBiasMagnitude: 0.5,
  evidenceBasis: Object.freeze(["recalls_edge_co_usage"]) as readonly string[]
});

export const SUPPORTS_SEED_PROFILE: PathSeedProfile = Object.freeze({
  relationKind: "supports",
  initialStrength: 0.5,
  governanceClass: "attention_only",
  recallBiasSign: 1,
  recallBiasMagnitude: 0.5,
  evidenceBasis: Object.freeze(["llm_supports_inference"]) as readonly string[]
});

export const DERIVES_FROM_SEED_PROFILE: PathSeedProfile = Object.freeze({
  relationKind: "derives_from",
  initialStrength: 0.5,
  governanceClass: "attention_only",
  recallBiasSign: 1,
  recallBiasMagnitude: 0.5,
  evidenceBasis: Object.freeze(["llm_derives_inference"]) as readonly string[]
});

export const SHARES_ENTITY_SEED_PROFILE: PathSeedProfile = Object.freeze({
  relationKind: "shares_entity",
  initialStrength: 0.2,
  governanceClass: "hint_only",
  recallBiasSign: 1,
  recallBiasMagnitude: 0.5,
  evidenceBasis: Object.freeze(["shared_entity_overlap"]) as readonly string[]
});

export const SIGNAL_GRAPH_REF_SEED_PROFILE: PathSeedProfile = Object.freeze({
  relationKind: "signal_graph_ref",
  initialStrength: 0.6,
  governanceClass: "recall_allowed",
  recallBiasSign: 1,
  recallBiasMagnitude: 0.5,
  evidenceBasis: Object.freeze(["signal_graph_reference"]) as readonly string[]
});

export const COHERES_WITH_SEED_PROFILE: PathSeedProfile = Object.freeze({
  relationKind: "coheres_with",
  initialStrength: 0.3,
  governanceClass: "hint_only",
  recallBiasSign: 1,
  recallBiasMagnitude: 0.5,
  evidenceBasis: Object.freeze(["embedding_cosine_coherence"]) as readonly string[]
});

// Answer-relation edge (HQ answer-overlap): banded above coheres_with — recall_allowed
// (the auto-build ceiling) and a stronger born strength, since "answers the same questions"
// is a sharper relevance signal than embedding co-occurrence.
export const ANSWERS_WITH_SEED_PROFILE: PathSeedProfile = Object.freeze({
  relationKind: "answers_with",
  initialStrength: 0.5,
  governanceClass: "recall_allowed",
  recallBiasSign: 1,
  recallBiasMagnitude: 0.5,
  evidenceBasis: Object.freeze(["hq_answer_overlap"]) as readonly string[]
});

export const EXCEPTION_TO_SEED_PROFILE: PathSeedProfile = Object.freeze({
  relationKind: "exception_to",
  initialStrength: 0.9,
  governanceClass: "recall_allowed",
  recallBiasSign: 0,
  recallBiasMagnitude: 0,
  evidenceBasis: Object.freeze(["exception_evidence"]) as readonly string[]
});

export const SUPERSEDES_SEED_PROFILE: PathSeedProfile = Object.freeze({
  relationKind: "supersedes",
  initialStrength: 0.9,
  governanceClass: "recall_allowed",
  recallBiasSign: -1,
  recallBiasMagnitude: 0.5,
  evidenceBasis: Object.freeze(["supersession_evidence"]) as readonly string[]
});

export const CONTRADICTS_SEED_PROFILE: PathSeedProfile = Object.freeze({
  relationKind: "contradicts",
  initialStrength: 0.9,
  governanceClass: "recall_allowed",
  recallBiasSign: -1,
  recallBiasMagnitude: 0.4,
  evidenceBasis: Object.freeze(["contradiction_evidence"]) as readonly string[]
});

export const INCOMPATIBLE_SEED_PROFILE: PathSeedProfile = Object.freeze({
  relationKind: "incompatible_with",
  initialStrength: 0.9,
  governanceClass: "recall_allowed",
  recallBiasSign: -1,
  recallBiasMagnitude: 0.3,
  evidenceBasis: Object.freeze(["incompatibility_evidence"]) as readonly string[]
});

export type PathMintOutcome =
  | "applied"
  | "already_present"
  | "rejected"
  | "failed";

export const AUTO_BUILD_GOVERNANCE_CEILING: PathGovernanceClass =
  "recall_allowed";

export interface PathRelationProposalRepoPort {
  create(relation: PathRelation): Readonly<PathRelation>;
  findByAnchorMemoryId?(
    memoryId: string,
    workspaceId: string
  ): Promise<readonly Readonly<PathRelation>[]>;
}

export interface CoUsageCounterPort {
  increment(input: {
    readonly workspaceId: string;
    readonly lowMemoryId: string;
    readonly highMemoryId: string;
    readonly seenAt: string;
  }): number | Promise<number>;
  delete(workspaceId: string, lowMemoryId: string, highMemoryId: string): void | Promise<void>;
  evictExpired(cutoff: string): number | Promise<number>;
  size(): number | Promise<number>;
}

export type PathRelationProposalEventPublisherPort = Pick<
  EventPublisher,
  "appendManyWithMutation"
>;

export interface MemoryAnchorExistencePort {
  workspaceOfObject(objectId: string): Promise<string | null>;
}

export type AnchorValidationFailure = {
  readonly anchorRole: "source" | "target";
  readonly objectId: string;
  readonly reason: "object_missing" | "object_foreign_workspace";
};

export interface PathRelationProposalServiceDeps {
  readonly repo: PathRelationProposalRepoPort;
  readonly counterStore: CoUsageCounterPort;
  readonly eventPublisher: PathRelationProposalEventPublisherPort;
  readonly memoryExistence?: MemoryAnchorExistencePort;
  readonly healthInboxPort?: PathFailureHealthInboxPort;
  readonly threshold?: number;
  readonly now?: () => string;
  readonly nowMs?: () => number;
  readonly counterTtlMs?: number;
  readonly generateId?: () => string;
  readonly warn?: (message: string, meta: Record<string, unknown>) => void;
}

const GOVERNANCE_RANK: Readonly<Record<PathGovernanceClass, number>> = Object.freeze({
  hint_only: 0,
  attention_only: 1,
  recall_allowed: 2,
  strictly_governed: 3
});

export function clampGovernanceToAutoBuildCeiling(
  requested: PathGovernanceClass
): PathGovernanceClass {
  return GOVERNANCE_RANK[requested] > GOVERNANCE_RANK[AUTO_BUILD_GOVERNANCE_CEILING]
    ? AUTO_BUILD_GOVERNANCE_CEILING
    : requested;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
