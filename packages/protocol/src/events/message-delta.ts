import { z } from "zod";
import {
  BoundedContentSchema,
  BoundedIdSchema,
  IsoDatetimeStringSchema,
  NonNegativeIntSchema,
} from "../shared/schema-primitives.js";

// Streaming event type registry
const streamingEventTypeValues = ["message.delta", "message.completed"] as const;

export const StreamingEventType = {
  MESSAGE_DELTA: "message.delta",
  MESSAGE_COMPLETED: "message.completed",
} as const;

export const StreamingEventTypeSchema = z.enum(streamingEventTypeValues);
// Token chunks are part of the conversation engine port.
const MessageDeltaEventSchema = z
  .object({
    type: z.literal("message.delta"),
    runId: BoundedIdSchema,
    messageId: BoundedIdSchema,
    delta: BoundedContentSchema,
    index: NonNegativeIntSchema,
    finishReason: z.enum(["stop", "length", "error"]).nullable().optional(),
    timestamp: IsoDatetimeStringSchema,
  })
  .strict()
  .readonly();

export type MessageDeltaEvent = Readonly<z.infer<typeof MessageDeltaEventSchema>>;

// MessageCompletedEvent — published after all deltas are assembled into the final message
export const MessageCompletedEventSchema = z
  .object({
    type: z.literal("message.completed"),
    runId: BoundedIdSchema,
    messageId: BoundedIdSchema,
    content: BoundedContentSchema,
    finishReason: z.enum(["stop", "length", "error"]),
    timestamp: IsoDatetimeStringSchema,
  })
  .strict()
  .readonly();
