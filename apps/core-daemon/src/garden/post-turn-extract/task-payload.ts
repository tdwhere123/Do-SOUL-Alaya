import type { ConversationMessage } from "@do-soul/alaya-protocol";
import {
  readVerifiedDeliverySourceObservation,
  type VerifiedDeliverySourceObservation
} from "../../runtime/recall-materialization-source-receipt.js";

const POST_TURN_EXTRACT_EXCERPT_MAX_CHARS = 800;

export interface PostTurnExtractTaskPayload {
  readonly run_id: string;
  readonly workspace_id: string;
  readonly created_at?: string;
  readonly source_observation: VerifiedDeliverySourceObservation | null;
  readonly turn_index: number;
  readonly turn_digest: Readonly<{
    readonly last_messages: readonly Readonly<{
      readonly role: string;
      readonly content_excerpt: string;
    }>[];
  }>;
}

export function parsePostTurnExtractTaskPayload(payload: unknown): PostTurnExtractTaskPayload {
  if (!isRecord(payload)) {
    throw new Error("Invalid post-turn extract task payload.");
  }
  const createdAt = parseOptionalStringField(payload, "created_at");
  return {
    run_id: parseStringField(payload, "run_id"),
    workspace_id: parseStringField(payload, "workspace_id"),
    ...(createdAt === undefined ? {} : { created_at: createdAt }),
    source_observation: readVerifiedDeliverySourceObservation(payload.source_observation),
    turn_index: parsePostTurnIndex(payload.turn_index),
    turn_digest: { last_messages: parsePostTurnMessages(payload.turn_digest) }
  };
}

export function buildPostTurnContent(payload: PostTurnExtractTaskPayload): string {
  return payload.turn_digest.last_messages
    .map((message) => `${message.role}: ${truncate(message.content_excerpt)}`)
    .join("\n");
}

export function buildPostTurnConversationMessages(
  payload: PostTurnExtractTaskPayload
): readonly ConversationMessage[] {
  return Object.freeze(
    payload.turn_digest.last_messages.map((message, index) => ({
      message_id: `post-turn-${payload.run_id}-${payload.turn_index}-${index}`,
      role: message.role as ConversationMessage["role"],
      content: truncate(message.content_excerpt)
    }))
  );
}

function parsePostTurnIndex(turnIndex: unknown): number {
  if (typeof turnIndex !== "number" || !Number.isInteger(turnIndex) || turnIndex < 0) {
    throw new Error("Invalid post-turn extract task payload.");
  }
  return turnIndex;
}

function parsePostTurnMessages(
  turnDigest: unknown
): readonly Readonly<{ readonly role: string; readonly content_excerpt: string }>[] {
  if (!isRecord(turnDigest) || !Array.isArray(turnDigest.last_messages)) {
    throw new Error("Invalid post-turn extract task payload.");
  }
  return turnDigest.last_messages.map(parsePostTurnDigestMessage);
}

function parsePostTurnDigestMessage(value: unknown): {
  readonly role: string;
  readonly content_excerpt: string;
} {
  if (!isRecord(value)) {
    throw new Error("Invalid post-turn extract task payload.");
  }
  return {
    role: parseStringField(value, "role"),
    content_excerpt: parseStringField(value, "content_excerpt")
  };
}

function parseStringField(record: Readonly<Record<string, unknown>>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Invalid post-turn extract task payload.");
  }
  return value;
}

function parseOptionalStringField(
  record: Readonly<Record<string, unknown>>,
  field: string
): string | undefined {
  return record[field] === undefined ? undefined : parseStringField(record, field);
}

function truncate(content: string): string {
  return content.slice(0, POST_TURN_EXTRACT_EXCERPT_MAX_CHARS);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
