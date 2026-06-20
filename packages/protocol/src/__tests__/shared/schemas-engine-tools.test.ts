import { describe, expect, it } from "vitest";
import {
  ConversationMessageSchema,
  EngineError,
  EngineErrorKind,
  EngineErrorSchema,
  EngineResultSchema,
  ExecShellToolInputSchema,
  ExecShellToolResultSchema,
  FileToolErrorSchema,
  ListDirectoryToolInputSchema,
  ListDirectoryToolResultSchema,
  ReadFileToolInputSchema,
  ReadFileToolResultSchema,
  SearchFilesToolInputSchema,
  SearchFilesToolResultSchema,
  ToolUseBlockSchema,
  WriteFileToolInputSchema,
  WriteFileToolResultSchema,
  type CandidateMemorySignal,
  type WorkspaceRunEvent
} from "../../index.js";

type IfEquals<X, Y, A = true, B = false> =
  (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? A : B;
type IsReadonlyProperty<T, K extends keyof T> = IfEquals<
  { [P in K]: T[P] },
  { -readonly [P in K]: T[P] },
  false,
  true
>;
type AssertTrue<T extends true> = T;
export type _WorkspaceRunEventReadonlyChecks = [
  AssertTrue<IsReadonlyProperty<WorkspaceRunEvent, "event_id">>,
  AssertTrue<IsReadonlyProperty<WorkspaceRunEvent, "entity_type">>,
  AssertTrue<IsReadonlyProperty<WorkspaceRunEvent, "entity_id">>,
  AssertTrue<IsReadonlyProperty<WorkspaceRunEvent, "workspace_id">>,
  AssertTrue<IsReadonlyProperty<WorkspaceRunEvent, "run_id">>,
  AssertTrue<IsReadonlyProperty<WorkspaceRunEvent, "caused_by">>,
  AssertTrue<IsReadonlyProperty<WorkspaceRunEvent, "revision">>,
  AssertTrue<IsReadonlyProperty<WorkspaceRunEvent, "created_at">>
];
export type _CandidateMemorySignalReadonlyChecks = [
  AssertTrue<IsReadonlyProperty<CandidateMemorySignal, "signal_id">>,
  AssertTrue<IsReadonlyProperty<CandidateMemorySignal, "workspace_id">>,
  AssertTrue<IsReadonlyProperty<CandidateMemorySignal, "run_id">>,
  AssertTrue<IsReadonlyProperty<CandidateMemorySignal, "surface_id">>,
  AssertTrue<IsReadonlyProperty<CandidateMemorySignal, "source">>,
  AssertTrue<IsReadonlyProperty<CandidateMemorySignal, "signal_kind">>,
  AssertTrue<IsReadonlyProperty<CandidateMemorySignal, "signal_state">>,
  AssertTrue<IsReadonlyProperty<CandidateMemorySignal, "object_kind">>,
  AssertTrue<IsReadonlyProperty<CandidateMemorySignal, "scope_hint">>,
  AssertTrue<IsReadonlyProperty<CandidateMemorySignal, "confidence">>,
  AssertTrue<IsReadonlyProperty<CandidateMemorySignal, "created_at">>
];


describe("EngineResultSchema", () => {
  const message = { role: "assistant", content: "Hello", message_id: "message-1" } as const;

  it("accepts a result without usage", () => {
    const result = { message, finish_reason: "stop" };
    expect(EngineResultSchema.parse(result)).toEqual(result);
  });

  it("accepts a result with usage", () => {
    const result = {
      message,
      finish_reason: "length",
      tool_uses: [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "soul.emit_candidate_signal",
          input: {
            workspace_id: "workspace-1",
            run_id: "run-1"
          }
        }
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 20
      }
    };

    expect(EngineResultSchema.parse(result)).toEqual(result);
  });

  it("rejects an invalid finish_reason", () => {
    expect(EngineResultSchema.safeParse({ message, finish_reason: "timeout" }).success).toBe(false);
  });

  it("rejects a missing message", () => {
    expect(EngineResultSchema.safeParse({ finish_reason: "stop" }).success).toBe(false);
  });

  it("accepts a result without tool_uses", () => {
    const result = { message, finish_reason: "stop" };
    expect(EngineResultSchema.parse(result)).toEqual(result);
  });

  it("rejects a tool_use block missing an id", () => {
    expect(
      EngineResultSchema.safeParse({
        message,
        finish_reason: "stop",
        tool_uses: [
          {
            type: "tool_use",
            name: "soul.emit_candidate_signal",
            input: {}
          }
        ]
      }).success
    ).toBe(false);
  });

  it("rejects negative usage tokens", () => {
    expect(
      EngineResultSchema.safeParse({
        message,
        finish_reason: "stop",
        usage: {
          prompt_tokens: -1,
          completion_tokens: 20
        }
      }).success
    ).toBe(false);
  });

  it("rejects fractional usage tokens", () => {
    expect(
      EngineResultSchema.safeParse({
        message,
        finish_reason: "stop",
        usage: {
          prompt_tokens: 1.5,
          completion_tokens: 20
        }
      }).success
    ).toBe(false);
  });
});


describe("ToolUseBlockSchema", () => {
  it("accepts a tool_use block", () => {
    const value = {
      type: "tool_use",
      id: "toolu_1",
      name: "soul.emit_candidate_signal",
      input: {
        workspace_id: "workspace-1",
        run_id: "run-1"
      }
    } as const;

    expect(ToolUseBlockSchema.parse(value)).toEqual(value);
  });

  it("rejects an invalid block type", () => {
    expect(
      ToolUseBlockSchema.safeParse({
        type: "tool_call",
        id: "toolu_1",
        name: "soul.emit_candidate_signal",
        input: {}
      }).success
    ).toBe(false);
  });
});


describe("file tool schemas", () => {
  it("accepts read_file input with an optional maxBytes override", () => {
    const value = {
      path: "packages/protocol/src/index.ts",
      maxBytes: 1024
    } as const;

    expect(ReadFileToolInputSchema.parse(value)).toEqual(value);
  });

  it("rejects read_file input with a non-positive maxBytes", () => {
    expect(
      ReadFileToolInputSchema.safeParse({
        path: "packages/protocol/src/index.ts",
        maxBytes: 0
      }).success
    ).toBe(false);
  });

  it("accepts read_file success and structured error results", () => {
    const success = {
      ok: true,
      content: "hello",
      bytesRead: 5
    } as const;
    const failure = {
      ok: false,
      code: "NOT_FOUND",
      message: "Missing file."
    } as const;

    expect(ReadFileToolResultSchema.parse(success)).toEqual(success);
    expect(FileToolErrorSchema.parse(failure)).toEqual(failure);
    expect(ReadFileToolResultSchema.parse(failure)).toEqual(failure);
  });

  it.each(["WRITE_ERROR", "TIMEOUT", "EXEC_ERROR"] as const)(
    "accepts %s as a file-tool error code",
    (code) => {
      const failure = {
        ok: false,
        code,
        message: `${code} failure.`
      } as const;

      expect(FileToolErrorSchema.parse(failure)).toEqual(failure);
    }
  );

  it("accepts list_directory input and lexical entry results", () => {
    const input = {
      path: "packages/protocol/src"
    } as const;
    const result = {
      ok: true,
      entries: [
        { name: "engine-port.ts", isDirectory: false },
        { name: "events", isDirectory: true }
      ]
    } as const;

    expect(ListDirectoryToolInputSchema.parse(input)).toEqual(input);
    expect(ListDirectoryToolResultSchema.parse(result)).toEqual(result);
  });

  it("accepts search_files input and the paths result shape", () => {
    const input = {
      pattern: "**/*.ts",
      baseDir: "packages/protocol/src",
      maxResults: 25
    } as const;
    const result = {
      ok: true,
      paths: ["engine-port.ts", "index.ts"]
    } as const;

    expect(SearchFilesToolInputSchema.parse(input)).toEqual(input);
    expect(SearchFilesToolResultSchema.parse(result)).toEqual(result);
  });

  it("rejects the stale search_files matches/truncated result shape", () => {
    expect(
      SearchFilesToolResultSchema.safeParse({
        ok: true,
        matches: ["engine-port.ts"],
        truncated: false
      }).success
    ).toBe(false);
  });

  it("accepts write_file input and the bytesWritten result shape", () => {
    const input = {
      path: "packages/engine-gateway/src/tools/write-file-tool.ts",
      content: "hello"
    } as const;
    const result = {
      ok: true,
      bytesWritten: 5
    } as const;

    expect(WriteFileToolInputSchema.parse(input)).toEqual(input);
    expect(WriteFileToolResultSchema.parse(result)).toEqual(result);
  });

  it("accepts exec_shell input and exit-code result shape", () => {
    const input = {
      command: "node",
      args: ["--version"],
      timeoutMs: 5000
    } as const;
    const result = {
      ok: true,
      exitCode: 42,
      stdout: "",
      stderr: "boom"
    } as const;

    expect(ExecShellToolInputSchema.parse(input)).toEqual(input);
    expect(ExecShellToolResultSchema.parse(result)).toEqual(result);
  });

  it("rejects exec_shell input with a non-positive timeout", () => {
    expect(
      ExecShellToolInputSchema.safeParse({
        command: "node",
        timeoutMs: 0
      }).success
    ).toBe(false);
  });
});


describe("EngineErrorSchema and EngineError", () => {
  it("accepts a network error payload", () => {
    const value = { message: "Network failed", kind: EngineErrorKind.NETWORK };
    expect(EngineErrorSchema.parse(value)).toEqual(value);
  });

  it("accepts an auth error payload", () => {
    const value = { message: "Auth failed", kind: EngineErrorKind.AUTH };
    expect(EngineErrorSchema.parse(value)).toEqual(value);
  });

  it("rejects an invalid error kind", () => {
    expect(EngineErrorSchema.safeParse({ message: "Boom", kind: "timeout" }).success).toBe(false);
  });

  it("rejects a missing message", () => {
    expect(EngineErrorSchema.safeParse({ kind: EngineErrorKind.MODEL_ERROR }).success).toBe(false);
  });

  it("constructs the EngineError class with the expected metadata", () => {
    const error = new EngineError("Boom", EngineErrorKind.RATE_LIMIT);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("EngineError");
    expect(error.kind).toBe(EngineErrorKind.RATE_LIMIT);
    expect(error.message).toBe("Boom");
  });
});

describe("ConversationMessageSchema", () => {
  it("accepts a user message", () => {
    const value = { message_id: "msg_user_1", role: "user", content: "hello" };
    expect(ConversationMessageSchema.parse(value)).toEqual(value);
  });

  it("accepts an assistant message", () => {
    const value = { message_id: "msg_assistant_1", role: "assistant", content: "hi" };
    expect(ConversationMessageSchema.parse(value)).toEqual(value);
  });

  it("rejects an invalid role", () => {
    expect(ConversationMessageSchema.safeParse({ message_id: "msg_1", role: "system", content: "nope" }).success).toBe(false);
  });

  it("rejects a missing message id", () => {
    expect(ConversationMessageSchema.safeParse({ role: "user", content: "hello" }).success).toBe(false);
  });
});

