import type { EngineBinding, EngineBindingSummary } from "./engine-binding.js";
import { z } from "zod";
import { EngineBindingSchema } from "./engine-binding.js";
import type { MessageDeltaEvent } from "../events/message-delta.js";
import {
  BOUNDED_DEFAULT_ARRAY_MAX,
  BoundedContentSchema,
  BoundedIdSchema,
  BoundedJsonObjectSchema,
  BoundedLabelSchema,
  BoundedReasonSchema,
  BoundedString,
  NonNegativeIntSchema
} from "../shared/schema-primitives.js";
import { ContextLensSchema } from "../soul/context-lens.js";

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
const EngineAttachmentDataSchema = BoundedString(30 * 1024 * 1024);

/**
 * File attachment resolved for a message before it is sent to the engine.
 * Providers convert these to their own multipart content block format.
 */
export const MessageAttachmentSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("image"),
      mime_type: BoundedLabelSchema,
      data: EngineAttachmentDataSchema
    })
    .strict(),
  z
    .object({
      type: z.literal("text_file"),
      filename: BoundedLabelSchema,
      content: EngineAttachmentDataSchema
    })
    .strict(),
  z
    .object({
      type: z.literal("unsupported"),
      filename: BoundedLabelSchema,
      mime_type: BoundedLabelSchema
    })
    .strict()
]).readonly();

export const EnginePortMessageSchema = z.object({
  role: EnginePortMessageRoleSchema,
  content: BoundedContentSchema,
  attachments: z.array(MessageAttachmentSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).optional()
}).strict().readonly();

export const ConversationRuntimeContextSchema = z.object({
  workspace_id: BoundedIdSchema,
  run_id: BoundedIdSchema,
  surface_id: BoundedIdSchema.nullable(),
  user_message_id: BoundedIdSchema,
  assistant_message_id: BoundedIdSchema.optional()
}).strict().readonly();

export const ConversationRequestSchema = z.object({
  messages: z.array(EnginePortMessageSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly(),
  systemPrompt: BoundedContentSchema,
  contextLens: ContextLensSchema.nullable(),
  binding: EngineBindingSchema,
  runtime_context: ConversationRuntimeContextSchema.optional()
}).strict().readonly();

export const EngineMessageSchema = z.object({
  role: z.literal("assistant"),
  content: BoundedContentSchema,
  message_id: BoundedIdSchema
}).strict().readonly();

export const EngineUsageSchema = z.object({
  prompt_tokens: NonNegativeIntSchema,
  completion_tokens: NonNegativeIntSchema
}).strict().readonly();

export const ToolUseBlockSchema = z.object({
  type: z.literal("tool_use"),
  id: BoundedIdSchema,
  name: BoundedLabelSchema,
  input: BoundedJsonObjectSchema
}).strict().readonly();

export const EngineResultSchema = z.object({
  message: EngineMessageSchema,
  finish_reason: EngineFinishReasonSchema,
  tool_uses: z.array(ToolUseBlockSchema).readonly().optional(),
  usage: EngineUsageSchema.optional()
}).strict().readonly();

/** Serializable DTO for engine failures crossing package or process boundaries. */
export const EngineErrorSchema = z.object({
  message: BoundedReasonSchema,
  kind: EngineErrorKindSchema
}).strict().readonly();

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
