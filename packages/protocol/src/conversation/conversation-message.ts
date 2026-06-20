import { z } from "zod";
import { BoundedContentSchema, BoundedIdSchema } from "../shared/schema-primitives.js";

const conversationMessageRoleValues = ["user", "assistant"] as const;

export const ConversationMessageRoleSchema = z.enum(conversationMessageRoleValues);

export const ConversationMessageSchema = z.object({
  message_id: BoundedIdSchema,
  role: ConversationMessageRoleSchema,
  content: BoundedContentSchema,
  /** IDs of files attached to this message. Only present for user messages with uploads. */
  file_ids: z.array(BoundedIdSchema).readonly().optional()
}).strict().readonly();

export type ConversationMessageRole = z.infer<typeof ConversationMessageRoleSchema>;
export type ConversationMessage = z.infer<typeof ConversationMessageSchema>;
