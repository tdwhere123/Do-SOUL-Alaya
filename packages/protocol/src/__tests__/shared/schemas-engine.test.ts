import { describe, expect, it } from "vitest";
import {
  ConversationRequestSchema,
  EngineBindingSchema,
  EngineBindingInputSchema,
  EngineBindingRecordSchema,
  EngineConnectionTestResultSchema,
  EngineErrorKind,
  EngineFinishReasonSchema,
  EngineMessageSchema,
  EnginePortMessageSchema,
  EngineProvider,
  EngineStatus,
  WorkspaceRunEventType,
  SignalEventType,
  SignalKind,
  SignalSource,
  SignalState,
  RunMode,
  RunState,
  WorkspaceKind,
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

import {
  engineBindingBase,
  engineBindingInputBase,
  validTimestamp,
  without
} from "./schemas-engine.fixtures.js";

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

  it("accepts a provider-neutral engine binding input with api_key_ref", () => {
    const input = {
      ...engineBindingInputBase,
      api_key: undefined,
      api_key_ref: "OPENAI_API_KEY"
    };

    expect(EngineBindingInputSchema.parse(input)).toEqual(input);
  });

  it("rejects an input without either api_key or api_key_ref", () => {
    expect(
      EngineBindingInputSchema.safeParse({
        ...engineBindingInputBase,
        api_key: undefined
      }).success
    ).toBe(false);
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

  it("accepts a persisted engine binding record with api_key_ref and no inline secret", () => {
    const record = {
      binding_id: "binding-ref",
      workspace_id: "workspace-1",
      provider_type: EngineProvider.OPENAI,
      base_url: null,
      api_key: "",
      api_key_ref: "OPENAI_API_KEY",
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
