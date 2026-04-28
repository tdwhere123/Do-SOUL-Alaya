import { z } from "zod";
import { ObjectLifecycleStateSchema } from "./lifecycle.js";

const evidenceHealthStateValues = ["verified", "questionable", "degraded", "broken"] as const;
const governanceRoleStateValues = ["standalone", "claimed", "contested", "winner"] as const;
const interactionCueStateValues = ["silent", "advisory", "blocking"] as const;

export const EvidenceHealthState = {
  VERIFIED: "verified",
  QUESTIONABLE: "questionable",
  DEGRADED: "degraded",
  BROKEN: "broken"
} as const;

export const GovernanceRoleState = {
  STANDALONE: "standalone",
  CLAIMED: "claimed",
  CONTESTED: "contested",
  WINNER: "winner"
} as const;

export const InteractionCueState = {
  SILENT: "silent",
  ADVISORY: "advisory",
  BLOCKING: "blocking"
} as const;

export const EvidenceHealthStateSchema = z.enum(evidenceHealthStateValues);
export const GovernanceRoleStateSchema = z.enum(governanceRoleStateValues);
export const InteractionCueStateSchema = z.enum(interactionCueStateValues);

export const CompositeObjectStatusSchema = z
  .object({
    lifecycle: ObjectLifecycleStateSchema,
    evidence_health: EvidenceHealthStateSchema.nullable(),
    governance_role: GovernanceRoleStateSchema.nullable(),
    interaction_cue: InteractionCueStateSchema.nullable()
  })
  .readonly();

export type EvidenceHealthState = z.infer<typeof EvidenceHealthStateSchema>;
export type GovernanceRoleState = z.infer<typeof GovernanceRoleStateSchema>;
export type InteractionCueState = z.infer<typeof InteractionCueStateSchema>;
export type CompositeObjectStatus = z.infer<typeof CompositeObjectStatusSchema>;
