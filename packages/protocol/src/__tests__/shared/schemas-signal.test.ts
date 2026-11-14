import { describe, expect, it } from "vitest";
import {
  SignalEventSchema,
  SignalEventType,
  SignalKind,
  SignalSource
} from "../../index.js";

import {
  validTimestamp,
  without} from "./schemas.fixtures.js";

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
        raw_payload: { excerpt: "hello" },
        source_observation: null
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

  it("accepts a source-grounding deferred triage payload with audit fields", () => {
    const event = {
      ...signalEventBase,
      event_id: "event-7b",
      event_type: SignalEventType.SOUL_SIGNAL_TRIAGED,
      payload: {
        signal_id: "signal-1",
        workspace_id: "workspace-1",
        run_id: "run-1",
        triage_result: "deferred",
        defer_reason: "source_assertion_not_self_contained",
        defer_class: "source_grounding"
      }
    };

    expect(SignalEventSchema.parse(event)).toEqual(event);
  });

  it("accepts a write-path deferred triage payload with reconciliation deferral", () => {
    const event = {
      ...signalEventBase,
      event_id: "event-7c",
      event_type: SignalEventType.SOUL_SIGNAL_TRIAGED,
      payload: {
        signal_id: "signal-1",
        workspace_id: "workspace-1",
        run_id: "run-1",
        triage_result: "deferred",
        defer_class: "write_path",
        deferral: "lease_busy"
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
