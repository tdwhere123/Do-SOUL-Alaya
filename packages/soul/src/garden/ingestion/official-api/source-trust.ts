import type { ConversationMessage } from "@do-soul/alaya-protocol";

export type OfficialApiSourceTrustRejection =
  | "source_messages_missing"
  | "source_locator_messages_missing"
  | "source_locator_required";

export function assessOfficialApiSourceTrust(input: {
  readonly hasSourceLocator: boolean;
  readonly turnContent: string;
  readonly turnMessages?: readonly ConversationMessage[];
  readonly allowLegacySingleUserSource?: boolean;
}): OfficialApiSourceTrustRejection | null {
  const messages = input.turnMessages ?? [];
  if (input.hasSourceLocator && messages.length === 0) {
    return "source_locator_messages_missing";
  }
  if (!input.hasSourceLocator && (
    messages.length > 0 || containsAssistantSource(input.turnContent, messages)
  )) {
    return "source_locator_required";
  }
  if (messages.length === 0 && input.allowLegacySingleUserSource !== true) {
    return "source_messages_missing";
  }
  return null;
}

function containsAssistantSource(
  turnContent: string,
  messages: readonly ConversationMessage[]
): boolean {
  if (messages.length > 0) {
    return messages.some((message) => message.role === "assistant");
  }
  return /(?:^|\s)assistant\s*:/iu.test(turnContent);
}
