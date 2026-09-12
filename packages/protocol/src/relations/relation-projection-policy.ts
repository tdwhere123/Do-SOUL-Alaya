import { createHash } from "node:crypto";
import type { PathGovernanceClass } from "./path-relation.js";

export type TemporalRelationProjectionProfile = Readonly<{
  readonly governanceClass: PathGovernanceClass;
  readonly recallBias: number;
  readonly salience: number;
  readonly strength: number;
}>;

export const TEMPORAL_RELATION_PROJECTION_PROFILES: Readonly<
  Record<string, TemporalRelationProjectionProfile>
> = Object.freeze({
  answers_with: { governanceClass: "recall_allowed", recallBias: 0.5, salience: 0.5, strength: 0.5 },
  coheres_with: { governanceClass: "hint_only", recallBias: 0.5, salience: 0.3, strength: 0.3 },
  co_recalled: { governanceClass: "attention_only", recallBias: 0.5, salience: 0.3, strength: 0.3 },
  contradicts: { governanceClass: "recall_allowed", recallBias: -0.4, salience: 0.9, strength: 0.9 },
  derives_from: { governanceClass: "attention_only", recallBias: 0.5, salience: 0.5, strength: 0.5 },
  exception_to: { governanceClass: "recall_allowed", recallBias: 0, salience: 0.9, strength: 0.9 },
  incompatible_with: { governanceClass: "recall_allowed", recallBias: -0.3, salience: 0.9, strength: 0.9 },
  shares_entity: { governanceClass: "hint_only", recallBias: 0.5, salience: 0.2, strength: 0.2 },
  signal_graph_ref: { governanceClass: "recall_allowed", recallBias: 0.5, salience: 0.6, strength: 0.6 },
  supersedes: { governanceClass: "recall_allowed", recallBias: -0.5, salience: 0.9, strength: 0.9 },
  supports: { governanceClass: "attention_only", recallBias: 0.5, salience: 0.5, strength: 0.5 },
  time_concern: { governanceClass: "recall_allowed", recallBias: 0.7, salience: 0.6, strength: 0.4 }
});

export const TEMPORAL_RELATION_PROJECTION_POLICY_ID = "relation-path-projection-v1";
export const TEMPORAL_RELATION_PROJECTION_POLICY_SHA256 = createHash("sha256")
  .update(JSON.stringify(TEMPORAL_RELATION_PROJECTION_PROFILES))
  .digest("hex");
