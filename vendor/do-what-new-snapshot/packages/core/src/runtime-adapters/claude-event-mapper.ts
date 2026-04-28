import { RuntimeEventSchema, type RuntimeEvent } from "@do-what/protocol";
import type { ClaudeSDKMessage } from "./claude-sdk-client.js";

export interface ClaudeEventMapInput {
  readonly emittedAt: string;
  readonly message: ClaudeSDKMessage;
  readonly nextSequence: number;
  readonly sessionId: string;
}

export interface ClaudeEventMapResult {
  readonly event: RuntimeEvent | null;
  readonly nextSequence: number;
}

export function mapClaudeEventToRuntimeEvent(input: ClaudeEventMapInput): ClaudeEventMapResult {
  if (isTextDeltaMessage(input.message)) {
    return {
      event: RuntimeEventSchema.parse({
        type: "message_delta",
        session_id: input.sessionId,
        emitted_at: input.emittedAt,
        delta: input.message.event.delta.text,
        sequence: input.nextSequence
      }),
      nextSequence: input.nextSequence + 1
    };
  }

  if (isFilesPersistedMessage(input.message)) {
    const pathHints = input.message.files
      .flatMap((file) =>
        isRecord(file) && typeof file.filename === "string" && (file.filename as string).trim().length > 0
          ? [file.filename as string]
          : []
      );

    if (pathHints.length === 0) {
      return {
        event: null,
        nextSequence: input.nextSequence
      };
    }

    return {
      event: RuntimeEventSchema.parse({
        type: "patch_emitted",
        session_id: input.sessionId,
        emitted_at: input.emittedAt,
        patch_id: input.message.uuid,
        path_hints: pathHints
      }),
      nextSequence: input.nextSequence
    };
  }

  return {
    event: null,
    nextSequence: input.nextSequence
  };
}

function isTextDeltaMessage(
  message: ClaudeSDKMessage
): message is ClaudeSDKMessage & {
  readonly type: "stream_event";
  readonly event: {
    readonly type: "content_block_delta";
    readonly delta: {
      readonly type: "text_delta";
      readonly text: string;
    };
  };
} {
  return (
    message.type === "stream_event" &&
    isRecord(message.event) &&
    message.event.type === "content_block_delta" &&
    isRecord(message.event.delta) &&
    message.event.delta.type === "text_delta" &&
    typeof message.event.delta.text === "string"
  );
}

function isFilesPersistedMessage(
  message: ClaudeSDKMessage
): message is ClaudeSDKMessage & {
  readonly type: "system";
  readonly subtype: "files_persisted";
  readonly files: readonly {
    readonly filename: string;
  }[];
  readonly uuid: string;
} {
  return (
    message.type === "system" &&
    message.subtype === "files_persisted" &&
    typeof message.uuid === "string" &&
    Array.isArray(message.files)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
