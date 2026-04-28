import { z } from "zod";
import { EngineBindingInputSchema, EngineBindingSummarySchema } from "./engine-binding.js";
import { EngineClassSchema } from "./runtime-run.js";
import { IsoDatetimeStringSchema, NonEmptyStringSchema } from "./schema-primitives.js";

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
  workspace_id: NonEmptyStringSchema,
  name: z.string(),
  root_path: z.string(),
  workspace_kind: WorkspaceKindSchema,
  repo_path: NonEmptyStringSchema.nullable(),
  default_engine_binding: NonEmptyStringSchema.nullable(),
  default_engine_class: EngineClassSchema.nullable().optional(),
  workspace_state: WorkspaceStateSchema,
  created_at: IsoDatetimeStringSchema,
  archived_at: IsoDatetimeStringSchema.nullable()
}).readonly();

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
  });

export const WorkspaceEngineConfigSchema = z
  .object({
    workspace_id: NonEmptyStringSchema,
    default_engine_class: EngineClassSchema.nullable(),
    conversation_binding: EngineBindingSummarySchema.nullable(),
    coding_engine_available: z.boolean()
  })
  .readonly();

export const WorkspaceEngineConfigUpdateSchema = z
  .union([
    z.object({
      default_engine_class: z.literal("conversation_engine"),
      conversation_binding: EngineBindingInputSchema.optional()
    }),
    z.object({
      default_engine_class: z.literal("coding_engine"),
      conversation_binding: EngineBindingInputSchema.optional()
    })
  ])
  .readonly();

const workspaceGitBindingStatusValues = ["unbound", "bound", "invalid"] as const;

export const WorkspaceGitBindingStatusSchema = z.enum(workspaceGitBindingStatusValues);

export const WorkspaceGitBindingSchema = z
  .object({
    workspace_id: NonEmptyStringSchema,
    repo_path: NonEmptyStringSchema.nullable(),
    status: WorkspaceGitBindingStatusSchema,
    reason: NonEmptyStringSchema.optional()
  })
  .readonly();

export const WorkspaceGitBindingUpdateSchema = z
  .object({
    repo_path: NonEmptyStringSchema.nullable()
  });

export type WorkspaceKind = z.infer<typeof WorkspaceKindSchema>;
export type WorkspaceState = z.infer<typeof WorkspaceStateSchema>;
export type Workspace = z.infer<typeof WorkspaceSchema>;
export type WorkspaceCreateInput = z.infer<typeof WorkspaceCreateInputSchema>;
export type WorkspaceEngineConfig = z.infer<typeof WorkspaceEngineConfigSchema>;
export type WorkspaceEngineConfigUpdate = z.infer<typeof WorkspaceEngineConfigUpdateSchema>;
export type WorkspaceGitBindingStatus = z.infer<typeof WorkspaceGitBindingStatusSchema>;
export type WorkspaceGitBinding = z.infer<typeof WorkspaceGitBindingSchema>;
export type WorkspaceGitBindingUpdate = z.infer<typeof WorkspaceGitBindingUpdateSchema>;
