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
  eventLogEntryBase,
  invalidTimestamp,
  runBase,
  validTimestamp,
  without,
  workspaceBase,
  workspaceEngineConfigBase
} from "./schemas.fixtures.js";

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

