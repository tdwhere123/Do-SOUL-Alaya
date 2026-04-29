import {
  Phase0EventType,
  StreamingEventType,
  MessageCompletedEventSchema,
  parsePhase0EventPayload,
  type ConversationMessage,
  type EnginePortMessage,
  type EventLogEntry
} from "@do-soul/alaya-protocol";

export function rebuildMessageHistory(events: readonly EventLogEntry[]): EnginePortMessage[] {
  return rebuildConversationMessages(events).map((message) => ({
    role: message.role,
    content: message.content
  }));
}

export function rebuildConversationMessages(events: readonly EventLogEntry[]): ConversationMessage[] {
  const messages: ConversationMessage[] = [];

  for (const event of events) {
    switch (event.event_type) {
      case Phase0EventType.RUN_MESSAGE_APPENDED: {
        const payload = parsePhase0EventPayload(event.event_type, event.payload_json);
        const fileIds = payload.file_ids?.filter((id) => id.length > 0);
        messages.push({
          message_id: payload.message_id,
          role: payload.role,
          content: payload.content,
          ...(fileIds !== undefined && fileIds.length > 0 ? { file_ids: fileIds } : {})
        });
        break;
      }
      case Phase0EventType.ENGINE_RESPONSE_RECEIVED: {
        const payload = parsePhase0EventPayload(event.event_type, event.payload_json);
        messages.push({
          message_id: payload.message_id,
          role: "assistant",
          content: payload.content
        });
        break;
      }
      case StreamingEventType.MESSAGE_COMPLETED: {
        const payload = MessageCompletedEventSchema.parse(event.payload_json);
        messages.push({
          message_id: payload.messageId,
          role: "assistant",
          content: payload.content
        });
        break;
      }
      default:
        break;
    }
  }

  return messages;
}
