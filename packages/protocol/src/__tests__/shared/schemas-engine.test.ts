import { describe, expect, it } from "vitest";
import {
  CandidateMemorySignalInputSchema,
  CandidateMemorySignalSchema,
  ConversationMessageSchema,
  ConversationRequestSchema,
  EngineBindingSchema,
  EngineBindingInputSchema,
  EngineBindingRecordSchema,
  EngineConnectionTestResultSchema,
  EngineError,
  EngineErrorKind,
  EngineErrorSchema,
  EngineFinishReasonSchema,
  EngineMessageSchema,
  EnginePortMessageSchema,
  EngineProvider,
  EngineResultSchema,
  EngineStatus,
  ExecShellToolInputSchema,
  ExecShellToolResultSchema,
  EmitCandidateSignalResponseSchema,
  EventLogEntrySchema,
  FileToolErrorSchema,
  parseWorkspaceRunEventPayload,
  parseSignalEventPayload,
  WorkspaceRunEventBaseSchema,
  WorkspaceRunEventSchema,
  WorkspaceRunEventType,
  SignalEventSchema,
  SignalEventType,
  ListDirectoryToolInputSchema,
  ListDirectoryToolResultSchema,
  ReadFileToolInputSchema,
  ReadFileToolResultSchema,
  RunHotStateSchema,
  SignalKind,
  SignalSource,
  SignalState,
  SearchFilesToolInputSchema,
  SearchFilesToolResultSchema,
  RunMode,
  RunSchema,
  RunState,
  ToolUseBlockSchema,
  WriteFileToolInputSchema,
  WriteFileToolResultSchema,
  WorkspaceCreatedEventSchema,
  WorkspaceCreateInputSchema,
  WorkspaceEngineConfigSchema,
  WorkspaceEngineConfigUpdateSchema,
  WorkspaceKind,
  WorkspaceSchema,
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
type _WorkspaceRunEventReadonlyChecks = [
  AssertTrue<IsReadonlyProperty<WorkspaceRunEvent, "event_id">>,
  AssertTrue<IsReadonlyProperty<WorkspaceRunEvent, "entity_type">>,
  AssertTrue<IsReadonlyProperty<WorkspaceRunEvent, "entity_id">>,
  AssertTrue<IsReadonlyProperty<WorkspaceRunEvent, "workspace_id">>,
  AssertTrue<IsReadonlyProperty<WorkspaceRunEvent, "run_id">>,
  AssertTrue<IsReadonlyProperty<WorkspaceRunEvent, "caused_by">>,
  AssertTrue<IsReadonlyProperty<WorkspaceRunEvent, "revision">>,
  AssertTrue<IsReadonlyProperty<WorkspaceRunEvent, "created_at">>
];
type _CandidateMemorySignalReadonlyChecks = [
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

function without<T extends Record<string, unknown>, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const clone = { ...value };
  delete clone[key];
  return clone;
}

const validTimestamp = "2026-03-15T00:00:00.000Z";
const invalidTimestamp = "2026-03-15 00:00:00";

const workspaceBase = {
  workspace_id: "workspace-1",
  name: "Workspace One",
  root_path: "D:/workspace-one",
  workspace_kind: WorkspaceKind.LOCAL_REPO,
  repo_path: null,
  default_engine_binding: null,
  default_engine_class: null,
  workspace_state: "active",
  created_at: validTimestamp,
  archived_at: null
} as const;

const workspaceEngineConfigBase = {
  workspace_id: "workspace-1",
  default_engine_class: "conversation_engine",
  conversation_binding: {
    provider_type: "custom",
    base_url: "https://proxy.example/v1",
    model: "proxy-model"
  },
  coding_engine_available: true
} as const;

const runBase = {
  run_id: "run-1",
  workspace_id: "workspace-1",
  title: "Investigate",
  goal: null,
  run_mode: RunMode.CHAT,
  engine_binding_id: null,
  engine_class: null,
  run_state: RunState.IDLE,
  current_surface_id: null,
  created_at: validTimestamp,
  last_active_at: "2026-03-15T00:05:00.000Z"
} as const;

const eventLogEntryBase = {
  event_id: "event-1",
  event_type: WorkspaceRunEventType.WORKSPACE_CREATED,
  entity_type: "workspace",
  entity_id: "workspace-1",
  workspace_id: "workspace-1",
  run_id: null,
  caused_by: null,
  revision: 0,
  payload_json: {
    workspace_id: "workspace-1",
    name: "Workspace One",
    workspace_kind: WorkspaceKind.LOCAL_REPO
  },
  created_at: validTimestamp
} as const;

const engineBindingBase = {
  binding_id: "binding-1",
  provider: EngineProvider.OPENAI,
  base_url: null,
  model: "gpt-4o-mini",
  api_key_ref: "OPENAI_API_KEY",
  config: {}
} as const;

const engineBindingInputBase = {
  provider_type: EngineProvider.OPENAI,
  base_url: null,
  api_key: "sk-openai",
  model: "gpt-4o-mini",
  config: {}
} as const;

const candidateMemorySignalBase = {
  signal_id: "signal-1",
  workspace_id: "workspace-1",
  run_id: "run-1",
  surface_id: null,
  source: SignalSource.MODEL_TOOL,
  signal_kind: SignalKind.POTENTIAL_SYNTHESIS,
  signal_state: SignalState.EMITTED,
  object_kind: "working_note",
  scope_hint: null,
  domain_tags: ["repo", "planning"],
  confidence: 0.75,
  evidence_refs: ["message-1", "message-2"],
  source_memory_refs: [],
  supersedes_refs: [],
  exception_to_refs: [],
  contradicts_refs: [],
  incompatible_with_refs: [],
  raw_payload: {
    summary: "Potential synthesis candidate",
    message_ids: ["message-1", "message-2"]
  },
  created_at: validTimestamp
} as const;

const candidateMemorySignalInputBase = {
  workspace_id: "workspace-1",
  run_id: "run-1",
  surface_id: null,
  signal_kind: SignalKind.POTENTIAL_CLAIM,
  object_kind: "constraint",
  scope_hint: null,
  domain_tags: ["security"],
  confidence: 0.5,
  evidence_refs: ["message-1"],
  raw_payload: {
    excerpt: "Do not expose secrets."
  }
} as const;

const emitCandidateSignalResponseBase = {
  signal_id: "signal-1",
  status: "emitted"
} as const;

describe("enum coverage", () => {
  it("exports the expected workspace, run, and engine status values", () => {
    expect(Object.values(WorkspaceKind)).toEqual(["local_repo", "docs_only", "mixed"]);
    expect(Object.values(RunMode)).toEqual(["chat", "analyze", "build", "review"]);
    expect(Object.values(RunState)).toEqual(["idle", "active", "archived"]);
    expect(Object.values(EngineStatus)).toEqual(["idle", "streaming", "error"]);
  });

  it("exports the expected event, provider, engine error, and finish reason values", () => {
    expect(Object.values(WorkspaceRunEventType)).toEqual([
      "workspace.created",
      "workspace.deleted",
      "workspace.engine_binding.updated",
      "workspace.default_engine_class.updated",
      "run.created",
      "run.deleted",
      "run.renamed",
      "run.engine_binding.updated",
      "run.message.appended",
      "engine.response.received"
    ]);
    expect(Object.values(SignalEventType)).toEqual([
      "soul.signal.emitted",
      "soul.signal.normalized",
      "soul.signal.triaged",
      "soul.signal.materialized",
      "soul.signal.materialization_failed"
    ]);
    expect(Object.values(SignalKind)).toEqual([
      "potential_claim",
      "potential_synthesis",
      "potential_handoff",
      "potential_evidence_anchor",
      "potential_conflict",
      "potential_preference"
    ]);
    expect(Object.values(SignalSource)).toEqual(["model_tool", "garden_compile", "user_seed", "import"]);
    expect(Object.values(SignalState)).toEqual([
      "emitted",
      "normalized",
      "triaged",
      "dropped",
      "deferred",
      "compiled",
      "materialized",
      "proposal",
      "reviewed",
      "accepted",
      "rejected",
      "superseded",
      "expired",
      "failed"
    ]);
    expect(Object.values(EngineProvider)).toEqual(["openai", "anthropic", "custom"]);
    expect(Object.values(EngineErrorKind)).toEqual(["network", "auth", "rate_limit", "model_error"]);
    expect(EngineFinishReasonSchema.options).toEqual(["stop", "length", "error"]);
  });
});

describe("EngineBindingSchema", () => {
  it("accepts an openai engine binding", () => {
    expect(EngineBindingSchema.parse(engineBindingBase)).toEqual(engineBindingBase);
  });

  it("accepts an engine binding with a direct api_key", () => {
    const directKeyBinding = {
      ...engineBindingBase,
      api_key: "sk-openai",
      api_key_ref: null
    };

    expect(EngineBindingSchema.parse(directKeyBinding)).toEqual(directKeyBinding);
  });

  it("accepts a custom engine binding", () => {
    const customBinding = {
      ...engineBindingBase,
      binding_id: "binding-2",
      provider: EngineProvider.CUSTOM,
      base_url: "https://example.test/v1",
      model: "custom-model",
      api_key: "sk-custom",
      api_key_ref: null,
      config: { compatibility: "openai" }
    };

    expect(EngineBindingSchema.parse(customBinding)).toEqual(customBinding);
  });

  it("rejects an invalid provider", () => {
    expect(EngineBindingSchema.safeParse({ ...engineBindingBase, provider: "local" }).success).toBe(false);
  });

  it("rejects a binding without either api_key or api_key_ref", () => {
    expect(
      EngineBindingSchema.safeParse({
        binding_id: "binding-3",
        provider: EngineProvider.OPENAI,
        base_url: null,
        model: "gpt-4o-mini",
        config: {}
      }).success
    ).toBe(false);
  });

  it("rejects an empty binding_id", () => {
    expect(EngineBindingSchema.safeParse({ ...engineBindingBase, binding_id: "" }).success).toBe(false);
  });
});

describe("EngineBindingInputSchema", () => {
  it("accepts a provider-neutral engine binding input", () => {
    expect(EngineBindingInputSchema.parse(engineBindingInputBase)).toEqual(engineBindingInputBase);
  });

  it("requires base_url for custom providers", () => {
    expect(
      EngineBindingInputSchema.safeParse({
        ...engineBindingInputBase,
        provider_type: EngineProvider.CUSTOM
      }).success
    ).toBe(false);
  });
});

describe("EngineBindingRecordSchema and EngineConnectionTestResultSchema", () => {
  it("accepts a persisted engine binding record", () => {
    const record = {
      binding_id: "binding-1",
      workspace_id: "workspace-1",
      provider_type: EngineProvider.OPENAI,
      base_url: null,
      api_key: "sk-openai",
      model: "gpt-4o-mini",
      config: {},
      created_at: validTimestamp,
      updated_at: validTimestamp
    };

    expect(EngineBindingRecordSchema.parse(record)).toEqual(record);
  });

  it("accepts a successful connection test result", () => {
    const result = {
      success: true,
      error: null,
      normalized_binding: {
        provider_type: EngineProvider.OPENAI,
        base_url: null,
        model: "gpt-4o-mini"
      },
      available_models: ["gpt-4o-mini"]
    };

    expect(EngineConnectionTestResultSchema.parse(result)).toEqual(result);
  });
});

describe("EnginePortMessageSchema", () => {
  it("accepts a user message", () => {
    const message = { role: "user", content: "Hello" };
    expect(EnginePortMessageSchema.parse(message)).toEqual(message);
  });

  it("accepts a system message", () => {
    const message = { role: "system", content: "System prompt" };
    expect(EnginePortMessageSchema.parse(message)).toEqual(message);
  });

  it("rejects an invalid role", () => {
    expect(EnginePortMessageSchema.safeParse({ role: "tool", content: "Nope" }).success).toBe(false);
  });

  it("rejects a missing content field", () => {
    expect(EnginePortMessageSchema.safeParse({ role: "assistant" }).success).toBe(false);
  });
});

describe("ConversationRequestSchema", () => {
  const requestBase = {
    messages: [{ role: "user", content: "Hello" }],
    systemPrompt: "You are helpful.",
    contextLens: null,
    binding: engineBindingBase
  } as const;

  it("accepts a single-turn request", () => {
    expect(ConversationRequestSchema.parse(requestBase)).toEqual(requestBase);
  });

  it("accepts a multi-message request", () => {
    const request = {
      ...requestBase,
      messages: [
        { role: "system", content: "System prompt already normalized." },
        { role: "user", content: "Question" },
        { role: "assistant", content: "Answer" }
      ]
    };

    expect(ConversationRequestSchema.parse(request)).toEqual(request);
  });

  it("accepts a valid ContextLens", () => {
    const lens = {
      runtime_id: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
      object_kind: "context_lens",
      task_surface_ref: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
      expires_at: null,
      derived_from: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
      retention_policy: "session_only",
      lens_entries: [
        {
          object_id: "9d599a9a-4940-4f23-a88e-0149f82ab021",
          object_kind: "memory_entry",
          relevance_score: 1,
          manifestation: "full_eligible"
        }
      ],
      not_a_priority_source: true
    } as const;
    const request = { ...requestBase, contextLens: lens };

    expect(ConversationRequestSchema.parse(request)).toEqual(request);
  });

  it("accepts an optional runtime context", () => {
    const request = {
      ...requestBase,
      runtime_context: {
        workspace_id: "workspace-1",
        run_id: "run-1",
        surface_id: null,
        user_message_id: "msg_user_1"
      }
    };

    expect(ConversationRequestSchema.parse(request)).toEqual(request);
  });

  it("rejects an invalid object contextLens", () => {
    expect(ConversationRequestSchema.safeParse({ ...requestBase, contextLens: {} }).success).toBe(false);
  });

  it("rejects undefined for contextLens", () => {
    expect(ConversationRequestSchema.safeParse(without(requestBase, "contextLens")).success).toBe(false);
    expect(ConversationRequestSchema.safeParse({ ...requestBase, contextLens: undefined }).success).toBe(false);
  });

  it("rejects a missing binding", () => {
    expect(ConversationRequestSchema.safeParse(without(requestBase, "binding")).success).toBe(false);
  });

  it("rejects an invalid runtime context", () => {
    expect(
      ConversationRequestSchema.safeParse({
        ...requestBase,
        runtime_context: {
          workspace_id: "",
          run_id: "run-1",
          surface_id: null,
          user_message_id: "msg_user_1"
        }
      }).success
    ).toBe(false);
  });
});

describe("EngineMessageSchema", () => {
  it("accepts an assistant message", () => {
    const message = { role: "assistant", content: "Hello", message_id: "message-1" };
    expect(EngineMessageSchema.parse(message)).toEqual(message);
  });

  it("accepts another assistant message", () => {
    const message = { role: "assistant", content: "World", message_id: "message-2" };
    expect(EngineMessageSchema.parse(message)).toEqual(message);
  });

  it("rejects a non-assistant role", () => {
    expect(EngineMessageSchema.safeParse({ role: "user", content: "Nope", message_id: "message-1" }).success).toBe(false);
  });

  it("rejects a missing message_id", () => {
    expect(EngineMessageSchema.safeParse({ role: "assistant", content: "No id" }).success).toBe(false);
  });

  it("rejects an empty message_id", () => {
    expect(EngineMessageSchema.safeParse({ role: "assistant", content: "No id", message_id: "" }).success).toBe(false);
  });
});

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
