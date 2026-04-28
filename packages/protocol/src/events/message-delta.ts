import { z } from "zod";
import {
  IsoDatetimeStringSchema,
  NonEmptyStringSchema,
  NonNegativeIntSchema,
} from "../schema-primitives.js";

// Streaming lifecycle enum
export const StreamingStatusSchema = z.enum(["idle", "streaming", "completed", "error"]);
export type StreamingStatus = z.infer<typeof StreamingStatusSchema>;

// Streaming event type registry
const streamingEventTypeValues = ["message.delta", "message.completed"] as const;

export const StreamingEventType = {
  MESSAGE_DELTA: "message.delta",
  MESSAGE_COMPLETED: "message.completed",
} as const;

export const StreamingEventTypeSchema = z.enum(streamingEventTypeValues);
export type StreamingEventTypeValue = z.infer<typeof StreamingEventTypeSchema>;

// MessageCreatedEvent — published when a run message exists before streaming deltas arrive
export const MessageCreatedEventSchema = z
  .object({
    messageId: NonEmptyStringSchema,
    runId: NonEmptyStringSchema,
    role: z.enum(["user", "assistant"]),
    createdAt: IsoDatetimeStringSchema.optional(),
  })
  .readonly();

export type MessageCreatedEvent = Readonly<z.infer<typeof MessageCreatedEventSchema>>;

// MessageDeltaEvent — a single streaming token chunk delivered via SSE
export const MessageDeltaEventSchema = z
  .object({
    type: z.literal("message.delta"),
    runId: NonEmptyStringSchema,
    messageId: NonEmptyStringSchema,
    delta: z.string(),
    index: NonNegativeIntSchema,
    finishReason: z.enum(["stop", "length", "error"]).nullable().optional(),
    timestamp: IsoDatetimeStringSchema,
  })
  .readonly();

export type MessageDeltaEvent = Readonly<z.infer<typeof MessageDeltaEventSchema>>;

// MessageCompletedEvent — published after all deltas are assembled into the final message
export const MessageCompletedEventSchema = z
  .object({
    type: z.literal("message.completed"),
    runId: NonEmptyStringSchema,
    messageId: NonEmptyStringSchema,
    content: z.string(),
    finishReason: z.enum(["stop", "length", "error"]),
    timestamp: IsoDatetimeStringSchema,
  })
  .readonly();

export type MessageCompletedEvent = Readonly<z.infer<typeof MessageCompletedEventSchema>>;

// RunStateChangedEvent — hot-state update emitted on run SSE channels
export const RunStateChangedEventSchema = z
  .object({
    runId: NonEmptyStringSchema,
    state: NonEmptyStringSchema,
    previousState: NonEmptyStringSchema.optional(),
  })
  .readonly();

export type RunStateChangedEvent = Readonly<z.infer<typeof RunStateChangedEventSchema>>;

// RunErrorEvent — hot-state error update emitted on run SSE channels
export const RunErrorEventSchema = z
  .object({
    runId: NonEmptyStringSchema,
    errorMessage: NonEmptyStringSchema,
    errorCode: NonEmptyStringSchema.optional(),
  })
  .readonly();

export type RunErrorEvent = Readonly<z.infer<typeof RunErrorEventSchema>>;
