import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema } from "../shared/schema-primitives.js";

export const RuntimeCapabilitiesSchema = z
  .object({
    supports_resume: z.boolean(),
    supports_interrupt: z.boolean(),
    supports_streaming_updates: z.boolean(),
    supports_tool_events: z.boolean(),
    supports_permission_requests: z.boolean(),
    supports_artifact_events: z.boolean(),
    supports_terminal_events: z.boolean()
  })
  .strict()
  .readonly();

export const RuntimeSandboxPolicySchema = z.enum(["default", "read_only", "workspace_write"]);
export const RuntimePermissionPolicySchema = z.enum(["default", "ask", "deny"]);
export const RuntimeNetworkPolicySchema = z.enum(["restricted", "disabled", "enabled"]);
export const RuntimeSessionRoleSchema = z.enum(["principal", "worker"]);
export const PrincipalRuntimeToolProfileSchema = z.enum(["default", "principal_coding"]);
export const WorkerRuntimeToolProfileSchema = z.enum(["default", "conversation_engine", "coding"]);

const RuntimeSessionConfigBaseSchema = z.object({
  workspace_id: NonEmptyStringSchema,
  cwd: NonEmptyStringSchema,
  writable_roots: z.array(NonEmptyStringSchema).readonly(),
  allowed_mcp_servers: z.array(NonEmptyStringSchema).readonly(),
  sandbox_policy: RuntimeSandboxPolicySchema,
  permission_policy: RuntimePermissionPolicySchema,
  network_policy: RuntimeNetworkPolicySchema
});

export const PrincipalRuntimeSessionConfigSchema = RuntimeSessionConfigBaseSchema.extend({
  role: z.literal("principal"),
  tool_profile: PrincipalRuntimeToolProfileSchema,
  run_id: NonEmptyStringSchema
})
  .strict();

export const WorkerRuntimeSessionConfigSchema = RuntimeSessionConfigBaseSchema.extend({
  role: z.literal("worker"),
  tool_profile: WorkerRuntimeToolProfileSchema,
  run_id: NonEmptyStringSchema.optional()
})
  .strict();

export const RuntimeSessionConfigSchema = z
  .discriminatedUnion("role", [PrincipalRuntimeSessionConfigSchema, WorkerRuntimeSessionConfigSchema])
  .readonly();

export const RuntimeSessionSchema = z
  .object({
    session_id: NonEmptyStringSchema
  })
  .strict()
  .readonly();

export const RuntimeCancelResultSchema = z
  .object({
    session_id: NonEmptyStringSchema,
    status: z.enum(["cancelled", "not_found", "already_finished"])
  })
  .strict()
  .readonly();

export const RuntimeTurnInputSchema = z
  .object({
    prompt: NonEmptyStringSchema
  })
  .strict()
  .readonly();

const RuntimeEventBaseSchema = z.object({
  session_id: NonEmptyStringSchema,
  emitted_at: IsoDatetimeStringSchema
});

export const RuntimeEventSchema = z
  .discriminatedUnion("type", [
    RuntimeEventBaseSchema.extend({
      type: z.literal("session_started")
    }).strict(),
    RuntimeEventBaseSchema.extend({
      type: z.literal("session_finished"),
      status: z.enum(["completed", "cancelled", "failed"]),
      result_summary: z.string().nullable()
    }).strict(),
    RuntimeEventBaseSchema.extend({
      type: z.literal("message_delta"),
      delta: z.string(),
      sequence: z.number().int().nonnegative()
    }).strict(),
    RuntimeEventBaseSchema.extend({
      type: z.literal("tool_call_started"),
      call_id: NonEmptyStringSchema,
      tool_id: NonEmptyStringSchema
    }).strict(),
    RuntimeEventBaseSchema.extend({
      type: z.literal("tool_call_finished"),
      call_id: NonEmptyStringSchema,
      tool_id: NonEmptyStringSchema,
      outcome: z.enum(["success", "error", "cancelled"]),
      result_summary: z.string().nullable()
    }).strict(),
    RuntimeEventBaseSchema.extend({
      type: z.literal("permission_requested"),
      request_id: NonEmptyStringSchema,
      tool_id: NonEmptyStringSchema,
      reason: NonEmptyStringSchema
    }).strict(),
    RuntimeEventBaseSchema.extend({
      type: z.literal("patch_emitted"),
      patch_id: NonEmptyStringSchema,
      path_hints: z.array(NonEmptyStringSchema).readonly()
    }).strict(),
    RuntimeEventBaseSchema.extend({
      type: z.literal("runtime_error"),
      error_code: NonEmptyStringSchema,
      message: NonEmptyStringSchema
    }).strict()
  ])
  .readonly();

export interface AgentRuntimePort {
  readonly kind: string;
  getCapabilities(): RuntimeCapabilities;
  createSession(config: RuntimeSessionConfig): Promise<RuntimeSession>;
  prompt(sessionId: string, input: RuntimeTurnInput): Promise<void>;
  cancel(sessionId: string): Promise<RuntimeCancelResult>;
  /**
   * Subscribe to runtime events for this adapter. Returns an unsubscribe function.
   *
   * Event ordering contract:
   * - `session_started` is emitted only when the runtime turn successfully begins
   *   (i.e. the underlying SDK handle is acquired and streaming starts).
   * - `session_finished` is always the last event emitted for a given session_id.
   *   No further events will be emitted after `session_finished`.
   * - `session_started` is NOT guaranteed to precede `session_finished`. If the
   *   session is cancelled before the turn begins (e.g. `cancel()` called before
   *   or during `startTurn` resolution), `session_finished` may be emitted without
   *   a prior `session_started`. Consumers must handle this case.
   * - `runtime_error` precedes `session_finished(status: "failed")` when an error
   *   terminates the session.
   */
  onEvent(handler: (event: RuntimeEvent) => void): () => void;
}

export type RuntimeCapabilities = Readonly<z.infer<typeof RuntimeCapabilitiesSchema>>;
export type RuntimeSandboxPolicy = z.infer<typeof RuntimeSandboxPolicySchema>;
export type RuntimePermissionPolicy = z.infer<typeof RuntimePermissionPolicySchema>;
export type RuntimeNetworkPolicy = z.infer<typeof RuntimeNetworkPolicySchema>;
export type RuntimeSessionRole = z.infer<typeof RuntimeSessionRoleSchema>;
export type PrincipalRuntimeToolProfile = z.infer<typeof PrincipalRuntimeToolProfileSchema>;
export type WorkerRuntimeToolProfile = z.infer<typeof WorkerRuntimeToolProfileSchema>;
export type RuntimeSessionConfig = Readonly<z.infer<typeof RuntimeSessionConfigSchema>>;
export type PrincipalRuntimeSessionConfig = Readonly<z.infer<typeof PrincipalRuntimeSessionConfigSchema>>;
export type WorkerRuntimeSessionConfig = Readonly<z.infer<typeof WorkerRuntimeSessionConfigSchema>>;
export type RuntimeSession = Readonly<z.infer<typeof RuntimeSessionSchema>>;
export type RuntimeCancelResult = Readonly<z.infer<typeof RuntimeCancelResultSchema>>;
export type RuntimeTurnInput = Readonly<z.infer<typeof RuntimeTurnInputSchema>>;
export type RuntimeEvent = Readonly<z.infer<typeof RuntimeEventSchema>>;
