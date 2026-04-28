import { z } from "zod";
import { NonEmptyStringSchema } from "./schema-primitives.js";
import { GovernanceSubjectSchema } from "./soul/governance-subject.js";
import { ToolCategorySchema, ToolScopeGuardSchema } from "./tool-spec.js";
import { NodeTemplateKindSchema } from "./node-template.js";

export const ToolRequestedBySchema = z.enum(["principal", "worker"]);
export const ToolPermissionResultSchema = z.enum(["allow", "ask", "deny"]);

export const ToolGovernanceQuerySchema = z
  .object({
    governance_subject: GovernanceSubjectSchema,
    tool_category: ToolCategorySchema,
    scope_guard: ToolScopeGuardSchema,
    target_surface: NonEmptyStringSchema.optional(),
    target_paths: z.array(NonEmptyStringSchema).readonly().optional(),
    destructive: z.boolean(),
    requested_by: ToolRequestedBySchema,
    request_context: z
      .object({
        node_template: NodeTemplateKindSchema,
        execution_stance_ref: NonEmptyStringSchema.optional(),
        project_ref: NonEmptyStringSchema
      })
      .strict()
      .readonly()
  })
  .strict()
  .readonly();

export const ToolGovernanceDecisionSchema = z
  .object({
    final_result: ToolPermissionResultSchema,
    matched_claim_refs: z.array(NonEmptyStringSchema).readonly(),
    matched_slot_refs: z.array(NonEmptyStringSchema).readonly(),
    hard_constraints_present: z.boolean(),
    requires_red_card: z.boolean(),
    explanation_summary: NonEmptyStringSchema
  })
  .strict()
  .readonly();

export type ToolRequestedBy = z.infer<typeof ToolRequestedBySchema>;
export type ToolPermissionResult = z.infer<typeof ToolPermissionResultSchema>;
export type ToolGovernanceQuery = Readonly<z.infer<typeof ToolGovernanceQuerySchema>>;
export type ToolGovernanceDecision = Readonly<z.infer<typeof ToolGovernanceDecisionSchema>>;
