import type { EngineBinding, EngineBindingSummary } from "./engine-binding.js";
import { z } from "zod";
import { EngineBindingSchema } from "./engine-binding.js";
import type { MessageDeltaEvent } from "./events/message-delta.js";
import { NonEmptyStringSchema, NonNegativeIntSchema } from "./schema-primitives.js";
import { ContextLensSchema } from "./soul/context-lens.js";

const enginePortMessageRoleValues = ["user", "assistant", "system"] as const;
const engineFinishReasonValues = ["stop", "length", "error"] as const;
const engineErrorKindValues = ["network", "auth", "rate_limit", "model_error"] as const;

export const EnginePortMessageRoleSchema = z.enum(enginePortMessageRoleValues);
export const EngineFinishReasonSchema = z.enum(engineFinishReasonValues);

export const EngineErrorKind = {
  NETWORK: "network",
  AUTH: "auth",
  RATE_LIMIT: "rate_limit",
  MODEL_ERROR: "model_error"
} as const;

export const EngineErrorKindSchema = z.enum(engineErrorKindValues);

/**
 * File attachment resolved for a message before it is sent to the engine.
 * Providers convert these to their own multipart content block format.
 */
export const MessageAttachmentSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("image"),
    mime_type: z.string(),
    data: z.string() // base64-encoded bytes
  }),
  z.object({
    type: z.literal("text_file"),
    filename: z.string(),
    content: z.string()
  }),
  z.object({
    type: z.literal("unsupported"),
    filename: z.string(),
    mime_type: z.string()
  })
]).readonly();

export const EnginePortMessageSchema = z.object({
  role: EnginePortMessageRoleSchema,
  content: z.string(),
  attachments: z.array(MessageAttachmentSchema).optional()
}).readonly();

export const ConversationRuntimeContextSchema = z.object({
  workspace_id: NonEmptyStringSchema,
  run_id: NonEmptyStringSchema,
  surface_id: NonEmptyStringSchema.nullable(),
  user_message_id: NonEmptyStringSchema,
  assistant_message_id: NonEmptyStringSchema.optional()
}).readonly();

export const ConversationRequestSchema = z.object({
  messages: z.array(EnginePortMessageSchema).readonly(),
  systemPrompt: z.string(),
  contextLens: ContextLensSchema.nullable(),
  binding: EngineBindingSchema,
  runtime_context: ConversationRuntimeContextSchema.optional()
}).readonly();

export const EngineMessageSchema = z.object({
  role: z.literal("assistant"),
  content: z.string(),
  message_id: NonEmptyStringSchema
}).readonly();

export const EngineUsageSchema = z.object({
  prompt_tokens: NonNegativeIntSchema,
  completion_tokens: NonNegativeIntSchema
}).readonly();

export const ToolUseBlockSchema = z.object({
  type: z.literal("tool_use"),
  id: NonEmptyStringSchema,
  name: NonEmptyStringSchema,
  input: z.record(z.unknown()).readonly()
}).readonly();

export const EngineResultSchema = z.object({
  message: EngineMessageSchema,
  finish_reason: EngineFinishReasonSchema,
  tool_uses: z.array(ToolUseBlockSchema).readonly().optional(),
  usage: EngineUsageSchema.optional()
}).readonly();

/** Serializable DTO for engine failures crossing package or process boundaries. */
export const EngineErrorSchema = z.object({
  message: z.string(),
  kind: EngineErrorKindSchema
}).readonly();

export type EngineErrorKind = z.infer<typeof EngineErrorKindSchema>;
export type EngineFinishReason = z.infer<typeof EngineFinishReasonSchema>;
export type MessageAttachment = z.infer<typeof MessageAttachmentSchema>;
export type EnginePortMessage = z.infer<typeof EnginePortMessageSchema>;
export type ConversationRuntimeContext = z.infer<typeof ConversationRuntimeContextSchema>;
export type ConversationRequest = z.infer<typeof ConversationRequestSchema>;
export type EngineMessage = z.infer<typeof EngineMessageSchema>;
export type EngineUsage = z.infer<typeof EngineUsageSchema>;
export type ToolUseBlock = z.infer<typeof ToolUseBlockSchema>;
export type EngineResult = z.infer<typeof EngineResultSchema>;
export type EngineErrorData = z.infer<typeof EngineErrorSchema>;

/** Runtime error used by engine implementations and adapters. */
export class EngineError extends Error {
  readonly kind: EngineErrorKind;

  constructor(message: string, kind: EngineErrorKind) {
    super(message);
    this.name = "EngineError";
    this.kind = kind;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface ConversationEnginePort {
  sendMessage(request: ConversationRequest): Promise<EngineResult>;
  streamMessage(request: ConversationRequest): AsyncGenerator<MessageDeltaEvent, void, unknown>;
}

export interface EngineBindingTestPort {
  testBinding(binding: EngineBinding): Promise<EngineBindingSummary & {
    readonly available_models: readonly string[];
  }>;
}
