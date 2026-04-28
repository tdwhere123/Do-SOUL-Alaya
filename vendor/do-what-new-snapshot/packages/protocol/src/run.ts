import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema } from "./schema-primitives.js";
import { EngineClassSchema } from "./runtime-run.js";

const runModeValues = ["chat", "analyze", "build", "review"] as const;
const runStateValues = ["idle", "active", "archived"] as const;

export const RunMode = {
  CHAT: "chat",
  ANALYZE: "analyze",
  BUILD: "build",
  REVIEW: "review"
} as const;

export const RunState = {
  IDLE: "idle",
  ACTIVE: "active",
  ARCHIVED: "archived"
} as const;

export const RunModeSchema = z.enum(runModeValues);
export const RunStateSchema = z.enum(runStateValues);

export const RunSchema = z.object({
  run_id: NonEmptyStringSchema,
  workspace_id: NonEmptyStringSchema,
  title: z.string(),
  goal: z.string().nullable(),
  run_mode: RunModeSchema,
  engine_binding_id: NonEmptyStringSchema.nullable(),
  engine_class: EngineClassSchema.nullable(),
  run_state: RunStateSchema,
  current_surface_id: NonEmptyStringSchema.nullable(),
  created_at: IsoDatetimeStringSchema,
  last_active_at: IsoDatetimeStringSchema
}).readonly();

export type RunMode = z.infer<typeof RunModeSchema>;
export type RunState = z.infer<typeof RunStateSchema>;
export type Run = z.infer<typeof RunSchema>;

export const RunRenameInputSchema = z.object({
  run_id: NonEmptyStringSchema,
  title: z.string().min(1).max(160)
}).readonly();