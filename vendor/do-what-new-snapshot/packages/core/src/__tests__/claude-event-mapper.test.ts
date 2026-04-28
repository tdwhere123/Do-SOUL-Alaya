import { describe, expect, it } from "vitest";
import { RuntimeEventSchema } from "@do-what/protocol";
import { mapClaudeEventToRuntimeEvent } from "../runtime-adapters/claude-event-mapper.js";
import {
  makeFilesPersistedMessage,
  makePartialAssistantMessage,
  makeResultMessage
} from "./fixtures/claude-sdk-messages.js";

const VALID_TIMESTAMP = "2026-04-13T10:00:00.000Z";

describe("mapClaudeEventToRuntimeEvent", () => {
  it("maps text deltas from streaming public messages", () => {
    const mapped = mapClaudeEventToRuntimeEvent({
      emittedAt: VALID_TIMESTAMP,
      message: makePartialAssistantMessage("hello"),
      nextSequence: 4,
      sessionId: "runtime-session-1"
    });

    expect(mapped.nextSequence).toBe(5);
    expect(RuntimeEventSchema.parse(mapped.event)).toMatchObject({
      type: "message_delta",
      session_id: "runtime-session-1",
      emitted_at: VALID_TIMESTAMP,
      delta: "hello",
      sequence: 4
    });
  });

  it("leaves terminal result handling to the adapter lifecycle", () => {
    const mapped = mapClaudeEventToRuntimeEvent({
      emittedAt: VALID_TIMESTAMP,
      message: makeResultMessage("done"),
      nextSequence: 0,
      sessionId: "runtime-session-1"
    });

    expect(mapped.event).toBeNull();
    expect(mapped.nextSequence).toBe(0);
  });

  it("maps persisted files to patch_emitted", () => {
    const mapped = mapClaudeEventToRuntimeEvent({
      emittedAt: VALID_TIMESTAMP,
      message: makeFilesPersistedMessage("packages/core/src/index.ts"),
      nextSequence: 0,
      sessionId: "runtime-session-1"
    });

    expect(RuntimeEventSchema.parse(mapped.event)).toMatchObject({
      type: "patch_emitted",
      session_id: "runtime-session-1",
      emitted_at: VALID_TIMESTAMP,
      patch_id: "00000000-0000-4000-8000-000000000003",
      path_hints: ["packages/core/src/index.ts"]
    });
  });

  it("returns null when files_persisted contains no successful file paths", () => {
    const mapped = mapClaudeEventToRuntimeEvent({
      emittedAt: VALID_TIMESTAMP,
      message: {
        ...makeFilesPersistedMessage(""),
        failed: [
          {
            file_id: "file-1",
            error: "write failed",
            filename: "packages/core/src/index.ts"
          }
        ],
        files: []
      },
      nextSequence: 0,
      sessionId: "runtime-session-1"
    });

    expect(mapped.event).toBeNull();
    expect(mapped.nextSequence).toBe(0);
  });

  it("skips files array elements with missing or non-string filename and maps the valid ones", () => {
    const mapped = mapClaudeEventToRuntimeEvent({
      emittedAt: VALID_TIMESTAMP,
      message: {
        ...makeFilesPersistedMessage("valid-path.ts"),
        files: [
          null,
          { file_id: "file-2" }, // missing filename
          { file_id: "file-3", filename: 42 }, // non-string filename
          { file_id: "file-4", filename: "valid-path.ts" }
        ]
      },
      nextSequence: 0,
      sessionId: "runtime-session-1"
    });

    expect(mapped.event).not.toBeNull();
    expect(mapped.event).toMatchObject({
      type: "patch_emitted",
      path_hints: ["valid-path.ts"]
    });
  });

  it("returns null when all files array elements have malformed filename fields", () => {
    const mapped = mapClaudeEventToRuntimeEvent({
      emittedAt: VALID_TIMESTAMP,
      message: {
        ...makeFilesPersistedMessage(""),
        files: [null, { file_id: "file-1" }, { file_id: "file-2", filename: 0 }]
      },
      nextSequence: 0,
      sessionId: "runtime-session-1"
    });

    expect(mapped.event).toBeNull();
    expect(mapped.nextSequence).toBe(0);
  });

  it("returns null for unsupported public message variants", () => {
    const mapped = mapClaudeEventToRuntimeEvent({
      emittedAt: VALID_TIMESTAMP,
      message: {
        type: "assistant",
        message: {
          content: []
        }
      },
      nextSequence: 0,
      sessionId: "runtime-session-1"
    });

    expect(mapped.event).toBeNull();
    expect(mapped.nextSequence).toBe(0);
  });
});
