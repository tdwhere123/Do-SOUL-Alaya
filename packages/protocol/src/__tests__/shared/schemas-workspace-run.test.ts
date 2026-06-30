import { describe, expect, it } from "vitest";
import {
  CandidateMemorySignalInputSchema,
  CandidateMemorySignalSchema,
  EmitCandidateSignalResponseSchema,
  parseSignalEventPayload,
  WorkspaceRunEventBaseSchema,
  WorkspaceRunEventSchema,
  WorkspaceRunEventType,
  SignalEventType,
  SignalKind,
  SignalSource,
  WorkspaceCreatedEventSchema,
  WorkspaceKind,
  type CandidateMemorySignal,
  type WorkspaceRunEvent
} from "../../index.js";
import { CANONICAL_ENTITIES_MAX } from "../../shared/schema-primitives.js";
import {
  candidateMemorySignalBase,
  candidateMemorySignalInputBase,
  emitCandidateSignalResponseBase,
  eventLogEntryBase,
  invalidTimestamp,
  without
} from "./schemas.fixtures.js";

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

const canonicalEntitiesAtLimit = Array.from(
  { length: CANONICAL_ENTITIES_MAX },
  (_, index) => `entity-${index + 1}`
);
const canonicalEntitiesOverLimit = [...canonicalEntitiesAtLimit, "entity-over-limit"];

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

  it("accepts canonical_entities at the configured limit", () => {
    const value = {
      ...candidateMemorySignalBase,
      canonical_entities: canonicalEntitiesAtLimit
    };

    expect(CandidateMemorySignalSchema.parse(value).canonical_entities).toEqual(canonicalEntitiesAtLimit);
  });

  it("rejects canonical_entities above the configured limit", () => {
    expect(
      CandidateMemorySignalSchema.safeParse({
        ...candidateMemorySignalBase,
        canonical_entities: canonicalEntitiesOverLimit
      }).success
    ).toBe(false);
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
