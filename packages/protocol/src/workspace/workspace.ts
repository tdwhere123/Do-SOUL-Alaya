import { z } from "zod";
import { EngineBindingInputSchema, EngineBindingSummarySchema } from "../engine/engine-binding.js";
import { EngineClassSchema } from "../runtime/runtime-run.js";
import {
  BoundedIdSchema,
  BoundedNameSchema,
  BoundedPathSchema,
  IsoDatetimeStringSchema
} from "../shared/schema-primitives.js";

const workspaceKindValues = ["local_repo", "docs_only", "mixed"] as const;
const workspaceStateValues = ["active", "archived"] as const;

export const WorkspaceKind = {
  LOCAL_REPO: "local_repo",
  DOCS_ONLY: "docs_only",
  MIXED: "mixed"
} as const;

export const WorkspaceState = {
  ACTIVE: "active",
  ARCHIVED: "archived"
} as const;

export const WorkspaceKindSchema = z.enum(workspaceKindValues);
export const WorkspaceStateSchema = z.enum(workspaceStateValues);

export const WorkspaceSchema = z.object({
  workspace_id: BoundedIdSchema,
  name: BoundedNameSchema,
  root_path: BoundedPathSchema,
  workspace_kind: WorkspaceKindSchema,
  repo_path: BoundedPathSchema.nullable(),
  default_engine_binding: BoundedIdSchema.nullable(),
  default_engine_class: EngineClassSchema.nullable().optional(),
  workspace_state: WorkspaceStateSchema,
  created_at: IsoDatetimeStringSchema,
  archived_at: IsoDatetimeStringSchema.nullable()
}).strict().readonly();

export const WorkspaceCreateInputSchema = WorkspaceSchema.unwrap()
  .pick({
    name: true,
    root_path: true,
    workspace_kind: true,
    repo_path: true,
    default_engine_binding: true
  })
  .partial({
    repo_path: true,
    default_engine_binding: true
  })
  .strict()
  .readonly();

export const WorkspaceEngineConfigSchema = z
  .object({
    workspace_id: BoundedIdSchema,
    default_engine_class: EngineClassSchema.nullable(),
    conversation_binding: EngineBindingSummarySchema.nullable(),
    coding_engine_available: z.boolean()
  })
  .strict()
  .readonly();

export const WorkspaceEngineConfigUpdateSchema = z
  .union([
    z
      .object({
        default_engine_class: z.literal("conversation_engine"),
        conversation_binding: EngineBindingInputSchema.optional()
      })
      .strict(),
    z
      .object({
        default_engine_class: z.literal("coding_engine"),
        conversation_binding: EngineBindingInputSchema.optional()
      })
      .strict()
  ])
  .readonly();

const workspaceGitBindingStatusValues = ["unbound", "bound", "invalid"] as const;

export const WorkspaceGitBindingStatusSchema = z.enum(workspaceGitBindingStatusValues);

export const WorkspaceGitBindingSchema = z
  .object({
    workspace_id: BoundedIdSchema,
    repo_path: BoundedPathSchema.nullable(),
    status: WorkspaceGitBindingStatusSchema,
    reason: BoundedNameSchema.optional()
  })
  .strict()
  .readonly();

export const WorkspaceGitBindingUpdateSchema = z
  .object({
    repo_path: BoundedPathSchema.nullable()
  })
  .strict()
  .readonly();

export type WorkspaceKind = z.infer<typeof WorkspaceKindSchema>;
export type WorkspaceState = z.infer<typeof WorkspaceStateSchema>;
export type Workspace = z.infer<typeof WorkspaceSchema>;
export type WorkspaceCreateInput = z.infer<typeof WorkspaceCreateInputSchema>;
export type WorkspaceEngineConfig = z.infer<typeof WorkspaceEngineConfigSchema>;
export type WorkspaceEngineConfigUpdate = z.infer<typeof WorkspaceEngineConfigUpdateSchema>;
export type WorkspaceGitBindingStatus = z.infer<typeof WorkspaceGitBindingStatusSchema>;
export type WorkspaceGitBinding = z.infer<typeof WorkspaceGitBindingSchema>;
export type WorkspaceGitBindingUpdate = z.infer<typeof WorkspaceGitBindingUpdateSchema>;
