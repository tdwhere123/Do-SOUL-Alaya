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

describe("WorkspaceRunEventSchema", () => {
  const workspaceRunEventBase = without(without(eventLogEntryBase, "event_type"), "payload_json");
  const workspaceEvent = {
    ...workspaceRunEventBase,
    event_type: WorkspaceRunEventType.WORKSPACE_CREATED,
    payload: {
      workspace_id: "workspace-1",
      name: "Workspace One",
      workspace_kind: WorkspaceKind.LOCAL_REPO
    }
  };

  it("accepts the readonly base schema", () => {
    expect(WorkspaceRunEventBaseSchema.parse(workspaceRunEventBase)).toEqual(workspaceRunEventBase);
  });

  it("accepts an exported child event schema", () => {
    expect(WorkspaceCreatedEventSchema.parse(workspaceEvent)).toEqual(workspaceEvent);
  });

  it("accepts a typed engine response event", () => {
    const event = {
      ...workspaceRunEventBase,
      event_id: "event-3",
      event_type: WorkspaceRunEventType.ENGINE_RESPONSE_RECEIVED,
      entity_type: "run",
      entity_id: "run-1",
      run_id: "run-1",
      payload: {
        run_id: "run-1",
        message_id: "message-2",
        content: "Done",
        finish_reason: "length"
      }
    };

    expect(WorkspaceRunEventSchema.parse(event)).toEqual(event);
  });

  it("accepts a typed workspace default-engine-class-updated event", () => {
    const event = {
      ...workspaceRunEventBase,
      event_id: "event-4",
      event_type: WorkspaceRunEventType.WORKSPACE_DEFAULT_ENGINE_CLASS_UPDATED,
      entity_type: "workspace",
      entity_id: "workspace-1",
      run_id: null,
      payload: {
        workspace_id: "workspace-1",
        default_engine_class: "coding_engine"
      }
    };

    expect(WorkspaceRunEventSchema.parse(event)).toEqual(event);
  });

  it("accepts a typed run engine-binding-updated event", () => {
    const event = {
      ...workspaceRunEventBase,
      event_id: "event-5",
      event_type: WorkspaceRunEventType.RUN_ENGINE_BINDING_UPDATED,
      entity_type: "run",
      entity_id: "run-1",
      run_id: "run-1",
      payload: {
        run_id: "run-1",
        engine_binding_id: "binding-2",
        previous_engine_binding_id: null
      }
    };

    expect(WorkspaceRunEventSchema.parse(event)).toEqual(event);
  });

  it("rejects an event with a mismatched payload", () => {
    const result = WorkspaceRunEventSchema.safeParse({
      ...workspaceRunEventBase,
      event_type: WorkspaceRunEventType.WORKSPACE_CREATED,
      payload: { workspace_id: "workspace-1" }
    });
    expect(result.success).toBe(false);
  });

  it("rejects an event without payload", () => {
    const result = WorkspaceRunEventSchema.safeParse(without(workspaceEvent, "payload"));
    expect(result.success).toBe(false);
  });

  it("rejects a negative revision", () => {
    const result = WorkspaceRunEventSchema.safeParse({
      ...workspaceEvent,
      revision: -1
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid created_at timestamp", () => {
    const result = WorkspaceRunEventSchema.safeParse({
      ...workspaceEvent,
      created_at: invalidTimestamp
    });
    expect(result.success).toBe(false);
  });
});

describe("CandidateMemorySignalSchema", () => {
  it("accepts a complete candidate memory signal", () => {
    expect(CandidateMemorySignalSchema.parse(candidateMemorySignalBase)).toEqual(candidateMemorySignalBase);
  });

  it("accepts nullable surface and scope hints", () => {
    const value = {
      ...candidateMemorySignalBase,
      signal_id: "signal-2",
      source: SignalSource.GARDEN_COMPILE
    };

    expect(CandidateMemorySignalSchema.parse(value)).toEqual(value);
  });

  it("rejects a missing signal_id", () => {
    expect(CandidateMemorySignalSchema.safeParse(without(candidateMemorySignalBase, "signal_id")).success).toBe(false);
  });

  it("rejects an invalid signal_kind", () => {
    expect(
      CandidateMemorySignalSchema.safeParse({
        ...candidateMemorySignalBase,
        signal_kind: "potential_memory"
      }).success
    ).toBe(false);
  });

  it("rejects a confidence above one", () => {
    expect(CandidateMemorySignalSchema.safeParse({ ...candidateMemorySignalBase, confidence: 1.1 }).success).toBe(false);
  });

  it("rejects a confidence below zero", () => {
    expect(CandidateMemorySignalSchema.safeParse({ ...candidateMemorySignalBase, confidence: -0.1 }).success).toBe(false);
  });
});

describe("CandidateMemorySignalInputSchema", () => {
  it("accepts a minimal MCP input payload", () => {
    expect(CandidateMemorySignalInputSchema.parse(candidateMemorySignalInputBase)).toEqual({
      ...candidateMemorySignalInputBase,
      source_memory_refs: [],
      supersedes_refs: [],
      exception_to_refs: [],
      contradicts_refs: [],
      incompatible_with_refs: []
    });
  });

  it("accepts a populated MCP input payload", () => {
    const value = {
      ...candidateMemorySignalInputBase,
      surface_id: "surface-1",
      scope_hint: "repo-root",
      domain_tags: ["security", "repo"],
      evidence_refs: ["message-1", "tool-call-1"],
      raw_payload: {
        excerpt: "Pin Node.js version",
        severity: "advisory"
      }
    };

    expect(CandidateMemorySignalInputSchema.parse(value)).toEqual({
      ...value,
      source_memory_refs: [],
      supersedes_refs: [],
      exception_to_refs: [],
      contradicts_refs: [],
      incompatible_with_refs: []
    });
  });

  it("rejects a payload with signal_id supplied by the caller", () => {
    expect(
      CandidateMemorySignalInputSchema.safeParse({
        ...candidateMemorySignalInputBase,
        signal_id: "signal-1"
      }).success
    ).toBe(false);
  });

  it("rejects an invalid signal_kind", () => {
    expect(
      CandidateMemorySignalInputSchema.safeParse({
        ...candidateMemorySignalInputBase,
        signal_kind: "potential_memory"
      }).success
    ).toBe(false);
  });
});

describe("EmitCandidateSignalResponseSchema", () => {
  it("accepts an emitted response", () => {
    expect(EmitCandidateSignalResponseSchema.parse(emitCandidateSignalResponseBase)).toEqual(emitCandidateSignalResponseBase);
  });

  it("accepts a normalized response", () => {
    const value = {
      ...emitCandidateSignalResponseBase,
      status: "normalized"
    };

    expect(EmitCandidateSignalResponseSchema.parse(value)).toEqual(value);
  });

  it("rejects an invalid status", () => {
    expect(
      EmitCandidateSignalResponseSchema.safeParse({
        ...emitCandidateSignalResponseBase,
        status: "triaged"
      }).success
    ).toBe(false);
  });

  it("rejects a missing signal_id", () => {
    expect(EmitCandidateSignalResponseSchema.safeParse(without(emitCandidateSignalResponseBase, "signal_id")).success).toBe(false);
  });
});

describe("signal payload parsing", () => {
  const validPayloads = [
    {
      eventType: SignalEventType.SOUL_SIGNAL_EMITTED,
      payload: {
        signal_id: "signal-1",
        workspace_id: "workspace-1",
        run_id: "run-1",
        source: SignalSource.MODEL_TOOL,
        signal_kind: SignalKind.POTENTIAL_CLAIM,
        source_memory_refs: ["memory-source"],
        supersedes_refs: ["memory-old"],
        exception_to_refs: ["memory-rule"],
        contradicts_refs: ["memory-contradiction"],
        incompatible_with_refs: ["memory-incompatible"],
        raw_payload: { excerpt: "hello" }
      }
    },
    {
      eventType: SignalEventType.SOUL_SIGNAL_NORMALIZED,
      payload: {
        signal_id: "signal-1",
        workspace_id: "workspace-1",
        run_id: "run-1",
        normalized_fields: {
          confidence: 0.5,
          domain_tags: ["security"]
        }
      }
    },
    {
      eventType: SignalEventType.SOUL_SIGNAL_TRIAGED,
      payload: {
        signal_id: "signal-1",
        workspace_id: "workspace-1",
        run_id: "run-1",
        triage_result: "accepted"
      }
    }
  ] as const;

  it.each(validPayloads)("parses $eventType payloads", ({ eventType, payload }) => {
    expect(parseSignalEventPayload(eventType, payload)).toEqual(payload);
  });

  it("rejects a mismatched emitted payload", () => {
    expect(() =>
      parseSignalEventPayload(SignalEventType.SOUL_SIGNAL_EMITTED, {
        signal_id: "signal-1",
        workspace_id: "workspace-1",
        run_id: "run-1",
        source: SignalSource.MODEL_TOOL
      })
    ).toThrow();
  });

  it("preserves first-class graph refs on emitted signal event payloads", () => {
    const payload = {
      signal_id: "signal-1",
      workspace_id: "workspace-1",
      run_id: "run-1",
      source: SignalSource.MODEL_TOOL,
      signal_kind: SignalKind.POTENTIAL_CLAIM,
      source_memory_refs: ["memory-source"],
      supersedes_refs: ["memory-old"],
      exception_to_refs: ["memory-rule"],
      contradicts_refs: ["memory-contradiction"],
      incompatible_with_refs: ["memory-incompatible"],
      raw_payload: { excerpt: "hello" }
    } as const;

    expect(parseSignalEventPayload(SignalEventType.SOUL_SIGNAL_EMITTED, payload)).toEqual(payload);
  });

  it("rejects an invalid triage result", () => {
    expect(() =>
      parseSignalEventPayload(SignalEventType.SOUL_SIGNAL_TRIAGED, {
        signal_id: "signal-1",
        workspace_id: "workspace-1",
        run_id: "run-1",
        triage_result: "reviewed"
      })
    ).toThrow();
  });
});

describe("SignalEventSchema", () => {
  const signalEventBase = {
    event_id: "event-5",
    entity_type: "candidate_memory_signal",
    entity_id: "signal-1",
    workspace_id: "workspace-1",
    run_id: "run-1",
    caused_by: "system",
    revision: 1,
    created_at: validTimestamp
  } as const;

  it("accepts an emitted event", () => {
    const event = {
      ...signalEventBase,
      event_type: SignalEventType.SOUL_SIGNAL_EMITTED,
      payload: {
        signal_id: "signal-1",
        workspace_id: "workspace-1",
        run_id: "run-1",
        source: SignalSource.MODEL_TOOL,
        signal_kind: SignalKind.POTENTIAL_SYNTHESIS,
        source_memory_refs: [],
        supersedes_refs: [],
        exception_to_refs: [],
        contradicts_refs: [],
        incompatible_with_refs: [],
        raw_payload: { excerpt: "hello" }
      }
    };

    expect(SignalEventSchema.parse(event)).toEqual(event);
  });

  it("accepts a normalized event", () => {
    const event = {
      ...signalEventBase,
      event_id: "event-6",
      event_type: SignalEventType.SOUL_SIGNAL_NORMALIZED,
      payload: {
        signal_id: "signal-1",
        workspace_id: "workspace-1",
        run_id: "run-1",
        normalized_fields: {
          domain_tags: ["repo"]
        }
      }
    };

    expect(SignalEventSchema.parse(event)).toEqual(event);
  });

  it("accepts a triaged event", () => {
    const event = {
      ...signalEventBase,
      event_id: "event-7",
      event_type: SignalEventType.SOUL_SIGNAL_TRIAGED,
      payload: {
        signal_id: "signal-1",
        workspace_id: "workspace-1",
        run_id: "run-1",
        triage_result: "deferred"
      }
    };

    expect(SignalEventSchema.parse(event)).toEqual(event);
  });

  it("rejects a mismatched payload", () => {
    const result = SignalEventSchema.safeParse({
      ...signalEventBase,
      event_type: SignalEventType.SOUL_SIGNAL_NORMALIZED,
      payload: {
        signal_id: "signal-1",
        workspace_id: "workspace-1",
        run_id: "run-1",
        triage_result: "accepted"
      }
    });

    expect(result.success).toBe(false);
  });

  it("rejects an event without payload", () => {
    const emittedEvent = {
      ...signalEventBase,
      event_type: SignalEventType.SOUL_SIGNAL_EMITTED,
      payload: {
        signal_id: "signal-1",
        workspace_id: "workspace-1",
        run_id: "run-1",
        source: SignalSource.MODEL_TOOL,
        signal_kind: SignalKind.POTENTIAL_CLAIM,
        raw_payload: { excerpt: "hello" }
      }
    };

    expect(SignalEventSchema.safeParse(without(emittedEvent, "payload")).success).toBe(false);
  });
});
