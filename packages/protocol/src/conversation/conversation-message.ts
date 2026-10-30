import { z } from "zod";
import {
  BoundedContentSchema,
  BoundedIdSchema,
  IsoDatetimeStringSchema
} from "../shared/schema-primitives.js";

const conversationMessageRoleValues = ["user", "assistant"] as const;

export const ConversationMessageRoleSchema = z.enum(conversationMessageRoleValues);

/** A source date's normalization coordinate is not a precise per-message/event timestamp. */
export const RecordedSourceTimeSchema = z.object({
  raw: z.string().min(1).max(256), normalized: IsoDatetimeStringSchema,
  level: z.enum(["session", "message"]), provenance: z.string().min(1).max(256),
  precision: z.enum(["day", "minute", "second", "millisecond"]),
  timezone: z.enum(["explicit_utc", "unspecified"]), normalization: z.literal("utc_coordinate_not_event_time")
}).strict().readonly();
export type RecordedSourceTime = z.infer<typeof RecordedSourceTimeSchema>;

export const ConversationMessageSchema = z.object({
  message_id: BoundedIdSchema,
  role: ConversationMessageRoleSchema,
  content: BoundedContentSchema,
  /** IDs of files attached to this message. Only present for user messages with uploads. */
  file_ids: z.array(BoundedIdSchema).readonly().optional(),
  // Source observation time for the utterance. Omitted means unknown — never fill with ingestion clock.
  created_at: IsoDatetimeStringSchema.optional(),
  // Source-level date metadata when an exact per-message observation time is unavailable.
  source_time: RecordedSourceTimeSchema.optional()
}).strict().readonly();

export type ConversationMessageRole = z.infer<typeof ConversationMessageRoleSchema>;
export type ConversationMessage = z.infer<typeof ConversationMessageSchema>;
