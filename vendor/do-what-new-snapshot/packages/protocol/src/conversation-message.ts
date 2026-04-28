import { z } from "zod";
import { NonEmptyStringSchema } from "./schema-primitives.js";

const conversationMessageRoleValues = ["user", "assistant"] as const;

export const ConversationMessageRoleSchema = z.enum(conversationMessageRoleValues);

export const ConversationMessageSchema = z.object({
  message_id: NonEmptyStringSchema,
  role: ConversationMessageRoleSchema,
  content: z.string(),
  /** IDs of files attached to this message. Only present for user messages with uploads. */
  file_ids: z.array(z.string()).readonly().optional()
}).readonly();

export type ConversationMessageRole = z.infer<typeof ConversationMessageRoleSchema>;
export type ConversationMessage = z.infer<typeof ConversationMessageSchema>;
