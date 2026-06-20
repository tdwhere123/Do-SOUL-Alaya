import { z } from "zod";
import {
  BoundedContentSchema,
  BoundedIdSchema,
  BoundedNameSchema,
  IsoDatetimeStringSchema
} from "../shared/schema-primitives.js";
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
const RunTitleSchema = BoundedNameSchema.max(160);

export const RunSchema = z.object({
  run_id: BoundedIdSchema,
  workspace_id: BoundedIdSchema,
  title: RunTitleSchema,
  goal: BoundedContentSchema.nullable(),
  run_mode: RunModeSchema,
  engine_binding_id: BoundedIdSchema.nullable(),
  engine_class: EngineClassSchema.nullable(),
  run_state: RunStateSchema,
  current_surface_id: BoundedIdSchema.nullable(),
  created_at: IsoDatetimeStringSchema,
  last_active_at: IsoDatetimeStringSchema
}).strict().readonly();

export type RunMode = z.infer<typeof RunModeSchema>;
export type RunState = z.infer<typeof RunStateSchema>;
export type Run = z.infer<typeof RunSchema>;

export const RunRenameInputSchema = z.object({
  run_id: BoundedIdSchema,
  title: RunTitleSchema
}).strict().readonly();

export const RunUpdateEngineBindingInputSchema = z.object({
  run_id: BoundedIdSchema,
  engine_binding_id: BoundedIdSchema
}).strict().readonly();
