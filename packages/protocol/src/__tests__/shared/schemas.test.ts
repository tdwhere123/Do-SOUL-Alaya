import { describe, expect, it } from "vitest";
import {
  CandidateMemorySignalInputSchema,
  CandidateMemorySignalSchema,
  EngineProvider,
  EngineStatus,
  EmitCandidateSignalResponseSchema,
  EventLogEntrySchema,
  parseWorkspaceRunEventPayload,
  parseSignalEventPayload,
  WorkspaceRunEventBaseSchema,
  WorkspaceRunEventSchema,
  WorkspaceRunEventType,
  SignalEventSchema,
  SignalEventType,
  RunHotStateSchema,
  SignalKind,
  SignalSource,
  SignalState,
  RunMode,
  RunSchema,
  RunState,
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
  candidateMemorySignalBase,
  candidateMemorySignalInputBase,
  emitCandidateSignalResponseBase,
  engineBindingInputBase,
  eventLogEntryBase,
  invalidTimestamp,
  runBase,
  validTimestamp,
  without,
  workspaceBase,
  workspaceEngineConfigBase
} from "./schemas.fixtures.js";

describe("WorkspaceSchema", () => {
  it("accepts a local repo workspace", () => {
    expect(WorkspaceSchema.parse(workspaceBase)).toEqual(workspaceBase);
  });

  it("accepts an archived docs workspace", () => {
    const archivedWorkspace = {
      ...workspaceBase,
      workspace_id: "workspace-2",
      workspace_kind: WorkspaceKind.DOCS_ONLY,
      default_engine_binding: "binding-2",
      workspace_state: "archived",
      archived_at: "2026-03-16T00:00:00.000Z"
    };

    expect(WorkspaceSchema.parse(archivedWorkspace)).toEqual(archivedWorkspace);
  });

  it("rejects a workspace without workspace_id", () => {
    expect(WorkspaceSchema.safeParse(without(workspaceBase, "workspace_id")).success).toBe(false);
  });

  it("rejects an invalid workspace_kind", () => {
    expect(WorkspaceSchema.safeParse({ ...workspaceBase, workspace_kind: "invalid" }).success).toBe(false);
  });

  it("rejects an empty workspace_id", () => {
    expect(WorkspaceSchema.safeParse({ ...workspaceBase, workspace_id: "" }).success).toBe(false);
  });

  it("rejects an invalid created_at timestamp", () => {
    expect(WorkspaceSchema.safeParse({ ...workspaceBase, created_at: invalidTimestamp }).success).toBe(false);
  });

  it("rejects an empty repo_path", () => {
    expect(WorkspaceSchema.safeParse({ ...workspaceBase, repo_path: "" }).success).toBe(false);
  });

  it("accepts workspace payloads that omit default_engine_class for backward compatibility", () => {
    const parsed = WorkspaceSchema.parse(without(workspaceBase, "default_engine_class"));
    expect(parsed.default_engine_class).toBeUndefined();
  });

  it("accepts workspace create payloads without repo_path", () => {
    expect(
      WorkspaceCreateInputSchema.parse({
        name: "Workspace One",
        root_path: "/tmp/workspace-one",
        workspace_kind: WorkspaceKind.LOCAL_REPO
      })
    ).toEqual({
      name: "Workspace One",
      root_path: "/tmp/workspace-one",
      workspace_kind: WorkspaceKind.LOCAL_REPO
    });
  });
});


describe("WorkspaceEngineConfig schemas", () => {
  it("accepts a workspace engine-config payload", () => {
    expect(WorkspaceEngineConfigSchema.parse(workspaceEngineConfigBase)).toEqual(workspaceEngineConfigBase);
  });

  it("accepts conversation_engine updates with a binding payload", () => {
    expect(
      WorkspaceEngineConfigUpdateSchema.parse({
        default_engine_class: "conversation_engine",
        conversation_binding: engineBindingInputBase
      })
    ).toEqual({
      default_engine_class: "conversation_engine",
      conversation_binding: engineBindingInputBase
    });
  });

  it("accepts coding_engine updates without a conversation binding", () => {
    expect(
      WorkspaceEngineConfigUpdateSchema.parse({
        default_engine_class: "coding_engine"
      })
    ).toEqual({
      default_engine_class: "coding_engine"
    });
  });

  it("accepts conversation_engine updates without a conversation binding payload", () => {
    expect(
      WorkspaceEngineConfigUpdateSchema.parse({
        default_engine_class: "conversation_engine"
      })
    ).toEqual({
      default_engine_class: "conversation_engine"
    });
  });
});


describe("RunSchema", () => {
  it("accepts a run with null optional fields", () => {
    expect(RunSchema.parse(runBase)).toEqual(runBase);
  });

  it("accepts a populated run", () => {
    const populatedRun = {
      ...runBase,
      run_id: "run-2",
      goal: "Review the repo",
      run_mode: RunMode.REVIEW,
      engine_binding_id: "binding-1",
      run_state: RunState.ACTIVE,
      current_surface_id: "surface-1"
    };

    expect(RunSchema.parse(populatedRun)).toEqual(populatedRun);
  });

  it("rejects an invalid run_mode", () => {
    expect(RunSchema.safeParse({ ...runBase, run_mode: "invalid" }).success).toBe(false);
  });

  it("rejects undefined for current_surface_id", () => {
    expect(RunSchema.safeParse({ ...runBase, current_surface_id: undefined }).success).toBe(false);
  });

  it("rejects an empty run_id", () => {
    expect(RunSchema.safeParse({ ...runBase, run_id: "" }).success).toBe(false);
  });

  it("rejects an invalid created_at timestamp", () => {
    expect(RunSchema.safeParse({ ...runBase, created_at: invalidTimestamp }).success).toBe(false);
  });
});


describe("RunHotStateSchema", () => {
  const hotStateBase = {
    run_id: "run-1",
    run_state: RunState.ACTIVE,
    active_surface_id: null,
    last_message_at: null,
    engine_status: EngineStatus.IDLE,
    updated_at: "2026-03-15T00:10:00.000Z"
  } as const;

  it("accepts a cold run snapshot", () => {
    expect(RunHotStateSchema.parse(hotStateBase)).toEqual(hotStateBase);
  });

  it("accepts a streaming run snapshot", () => {
    const streamingState = {
      ...hotStateBase,
      active_surface_id: "surface-1",
      last_message_at: "2026-03-15T00:09:59.000Z",
      engine_status: EngineStatus.STREAMING
    };

    expect(RunHotStateSchema.parse(streamingState)).toEqual(streamingState);
  });

  it("rejects an invalid engine_status", () => {
    expect(RunHotStateSchema.safeParse({ ...hotStateBase, engine_status: "pending" }).success).toBe(false);
  });

  it("rejects undefined for last_message_at", () => {
    expect(RunHotStateSchema.safeParse({ ...hotStateBase, last_message_at: undefined }).success).toBe(false);
  });

  it("rejects an empty active_surface_id", () => {
    expect(RunHotStateSchema.safeParse({ ...hotStateBase, active_surface_id: "" }).success).toBe(false);
  });

  it("rejects an invalid updated_at timestamp", () => {
    expect(RunHotStateSchema.safeParse({ ...hotStateBase, updated_at: invalidTimestamp }).success).toBe(false);
  });
});


describe("EventLogEntrySchema", () => {
  it("accepts a workspace event entry", () => {
    expect(EventLogEntrySchema.parse(eventLogEntryBase)).toEqual(eventLogEntryBase);
  });

  it("accepts a run-scoped event entry", () => {
    const runEvent = {
      ...eventLogEntryBase,
      event_id: "event-2",
      event_type: WorkspaceRunEventType.RUN_MESSAGE_APPENDED,
      entity_type: "run",
      entity_id: "run-1",
      run_id: "run-1",
      caused_by: "user",
      payload_json: {
        run_id: "run-1",
        role: "user",
        content: "Hello",
        message_id: "message-1"
      }
    };

    expect(EventLogEntrySchema.parse(runEvent)).toEqual(runEvent);
  });

  it("accepts a signal event entry", () => {
    const signalEvent = {
      ...eventLogEntryBase,
      event_id: "event-3",
      event_type: SignalEventType.SOUL_SIGNAL_EMITTED,
      entity_type: "candidate_memory_signal",
      entity_id: "signal-1",
      run_id: "run-1",
      payload_json: {
        signal_id: "signal-1",
        workspace_id: "workspace-1",
        run_id: "run-1",
        source: SignalSource.MODEL_TOOL,
        signal_kind: SignalKind.POTENTIAL_CLAIM,
        raw_payload: { excerpt: "hello" }
      }
    };

    expect(EventLogEntrySchema.parse(signalEvent)).toEqual(signalEvent);
  });

  it("rejects a missing event_id", () => {
    expect(EventLogEntrySchema.safeParse(without(eventLogEntryBase, "event_id")).success).toBe(false);
  });

  it("rejects an invalid workspace-run event type", () => {
    expect(EventLogEntrySchema.safeParse({ ...eventLogEntryBase, event_type: "engine.error" }).success).toBe(false);
  });

  it("rejects a negative revision", () => {
    expect(EventLogEntrySchema.safeParse({ ...eventLogEntryBase, revision: -1 }).success).toBe(false);
  });

  it("rejects an invalid created_at timestamp", () => {
    expect(EventLogEntrySchema.safeParse({ ...eventLogEntryBase, created_at: invalidTimestamp }).success).toBe(false);
  });
});


describe("workspace-run payload parsing", () => {
  const validPayloads = [
    {
      eventType: WorkspaceRunEventType.WORKSPACE_CREATED,
      payload: {
        workspace_id: "workspace-1",
        name: "Workspace One",
        workspace_kind: WorkspaceKind.LOCAL_REPO
      }
    },
    {
      eventType: WorkspaceRunEventType.WORKSPACE_DELETED,
      payload: { workspace_id: "workspace-1" }
    },
    {
      eventType: WorkspaceRunEventType.WORKSPACE_ENGINE_BINDING_UPDATED,
      payload: {
        workspace_id: "workspace-1",
        binding_id: "binding-1",
        provider_type: EngineProvider.OPENAI,
        model: "gpt-4o-mini",
        base_url: null
      }
    },
    {
      eventType: WorkspaceRunEventType.WORKSPACE_DEFAULT_ENGINE_CLASS_UPDATED,
      payload: {
        workspace_id: "workspace-1",
        default_engine_class: "conversation_engine"
      }
    },
    {
      eventType: WorkspaceRunEventType.RUN_CREATED,
      payload: {
        run_id: "run-1",
        workspace_id: "workspace-1",
        run_mode: RunMode.BUILD,
        title: "Ship it"
      }
    },
    {
      eventType: WorkspaceRunEventType.RUN_DELETED,
      payload: { run_id: "run-1", workspace_id: "workspace-1" }
    },
    {
      eventType: WorkspaceRunEventType.RUN_ENGINE_BINDING_UPDATED,
      payload: {
        run_id: "run-1",
        engine_binding_id: "binding-2",
        previous_engine_binding_id: "binding-1"
      }
    },
    {
      eventType: WorkspaceRunEventType.RUN_MESSAGE_APPENDED,
      payload: {
        run_id: "run-1",
        role: "assistant",
        content: "Hi",
        message_id: "message-1"
      }
    },
    {
      eventType: WorkspaceRunEventType.ENGINE_RESPONSE_RECEIVED,
      payload: {
        run_id: "run-1",
        message_id: "message-2",
        content: "Done",
        finish_reason: "stop"
      }
    }
  ] as const;

  it.each(validPayloads)("parses $eventType payloads", ({ eventType, payload }) => {
    expect(parseWorkspaceRunEventPayload(eventType, payload)).toEqual(payload);
  });

  it("rejects a mismatched payload for the event type", () => {
    expect(() =>
      parseWorkspaceRunEventPayload(WorkspaceRunEventType.RUN_CREATED, {
        workspace_id: "workspace-1"
      })
    ).toThrow();
  });

  it("rejects a payload with the wrong enum value", () => {
    expect(() =>
      parseWorkspaceRunEventPayload(WorkspaceRunEventType.RUN_MESSAGE_APPENDED, {
        run_id: "run-1",
        role: "system",
        content: "Nope",
        message_id: "message-1"
      })
    ).toThrow();
  });

  it("rejects an empty message_id", () => {
    expect(() =>
      parseWorkspaceRunEventPayload(WorkspaceRunEventType.ENGINE_RESPONSE_RECEIVED, {
        run_id: "run-1",
        message_id: "",
        content: "Done",
        finish_reason: "stop"
      })
    ).toThrow();
  });

  it("rejects an invalid finish_reason", () => {
    expect(() =>
      parseWorkspaceRunEventPayload(WorkspaceRunEventType.ENGINE_RESPONSE_RECEIVED, {
        run_id: "run-1",
        message_id: "message-2",
        content: "Done",
        finish_reason: "timeout"
      })
    ).toThrow();
  });
});
