import { z } from "zod";
import { NonEmptyStringSchema } from "./schema-primitives.js";

export const ToolCategorySchema = z.enum([
  "read",
  "write",
  "exec",
  "network",
  "validation",
  "evidence",
  "memory",
  "governance"
]);

export const ToolScopeGuardSchema = z.enum(["workspace", "worktree", "project", "global"]);
export const ToolInterruptBehaviorSchema = z.enum(["continue", "wait", "abort"]);
export const ToolRollbackSupportSchema = z.enum(["none", "best_effort", "guaranteed"]);

export const ToolSpecSchema = z
  .object({
    tool_id: NonEmptyStringSchema,
    category: ToolCategorySchema,
    description: NonEmptyStringSchema,
    scope_guard: ToolScopeGuardSchema,
    read_only: z.boolean(),
    destructive: z.boolean(),
    concurrency_safe: z.boolean(),
    interrupt_behavior: ToolInterruptBehaviorSchema,
    requires_confirmation: z.boolean(),
    requires_evidence_reopen: z.boolean(),
    rollback_support: ToolRollbackSupportSchema,
    fast_path_eligible: z.boolean()
  })
  .strict()
  .readonly();

export type ToolCategory = z.infer<typeof ToolCategorySchema>;
export type ToolScopeGuard = z.infer<typeof ToolScopeGuardSchema>;
export type ToolInterruptBehavior = z.infer<typeof ToolInterruptBehaviorSchema>;
export type ToolRollbackSupport = z.infer<typeof ToolRollbackSupportSchema>;
export type ToolSpec = Readonly<z.infer<typeof ToolSpecSchema>>;
