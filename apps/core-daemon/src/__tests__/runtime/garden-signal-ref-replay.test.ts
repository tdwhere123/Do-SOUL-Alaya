import { describe, expect, it, vi } from "vitest";
import {
  CandidateMemorySignalSchema,
  SignalEventType,
  type CandidateMemorySignal,
  type EventLogEntry
} from "@do-soul/alaya-protocol";
import { SignalService } from "@do-soul/alaya-core";

import { createGardenSignalRefReplayPort } from "../../runtime/garden-signal-ref-replay.js";

function buildSignal(): CandidateMemorySignal {
  return CandidateMemorySignalSchema.parse({
    signal_id: "signal-1",
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    source: "model_tool",
    signal_kind: "potential_claim",
    signal_state: "emitted",
    object_kind: "fact",
    scope_hint: "project",
    domain_tags: ["recall"],
    confidence: 0.9,
    evidence_refs: [],
    source_memory_refs: ["memory-prior"],
    supersedes_refs: [],
    exception_to_refs: [],
    contradicts_refs: [],
    incompatible_with_refs: [],
    raw_payload: { distilled_fact: "A grounded replay fact." },
    source_observation: {
      observed_at: "2026-07-16T12:34:56.000Z",
      authority: "trusted_host_event",
      source_event_id: "host-receipt-should-not-be-the-anchor"
    },
    created_at: "2026-07-16T12:35:00.000Z"
  });
}

async function emitCanonicalSignalEnvelope(signal: CandidateMemorySignal): Promise<readonly EventLogEntry[]> {
  const rows: EventLogEntry[] = [];
  const signals = new Map<string, CandidateMemorySignal>();
  const eventLogRepo = {
    append: vi.fn((input: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => {
      const entry: EventLogEntry = {
        ...input,
        event_id: `event-${rows.length + 1}`,
        created_at: "2026-07-16T12:35:01.000Z",
        revision: rows.length + 1
      };
      rows.push(entry);
      return entry;
    }),
    queryByEntity: vi.fn(async (entityType: string, entityId: string) =>
      rows.filter((entry) => entry.entity_type === entityType && entry.entity_id === entityId)
    )
  };
  const signalRepo = {
    create: vi.fn(async (candidate: CandidateMemorySignal) => {
      signals.set(candidate.signal_id, candidate);
      return candidate;
    }),
    getById: vi.fn(async (signalId: string) => signals.get(signalId) ?? null),
    listByRun: vi.fn(async () => []),
    updateState: vi.fn(async (signalId: string, signalState: CandidateMemorySignal["signal_state"]) => {
      const prior = signals.get(signalId);
      if (prior === undefined) throw new Error("missing signal");
      const next = { ...prior, signal_state: signalState };
      signals.set(signalId, next);
      return next;
    })
  };
  const signalService = new SignalService({
    eventLogRepo,
    signalRepo,
    runtimeNotifier: { notifyEntry: vi.fn() }
  });

  await signalService.receiveSignal(signal);
  return rows;
}

describe("Garden signal-ref replay admission", () => {
  it("uses the canonical signal-emitted EventLog id and observed receipt time, never the source receipt id", async () => {
    const signal = buildSignal();
    const rows = await emitCanonicalSignalEnvelope(signal);
    const replaySignalRefs = vi.fn(async () => []);
    const emitted = rows.find((entry) => entry.event_type === SignalEventType.SOUL_SIGNAL_EMITTED);
    expect(emitted).toBeDefined();
    const port = createGardenSignalRefReplayPort({
      eventLogRepo: {
        append: vi.fn(),
        queryByEntity: vi.fn(async () => rows)
      },
      evidenceCapsuleLookup: {
        findByIds: vi.fn(async () => [{
          object_id: "evidence-created-with-memory",
          event_anchor: {
            event_type: SignalEventType.SOUL_SIGNAL_EMITTED,
            event_id: emitted!.event_id,
            occurred_at: "2026-07-16T12:34:56.000Z"
          }
        }])
      },
      materializationRouter: { replaySignalRefs }
    });

    await port.replaySignalRefs({
      newMemoryId: "memory-new",
      memoryEvidenceIds: ["evidence-created-with-memory"],
      signal
    });

    expect(replaySignalRefs).toHaveBeenCalledWith(expect.objectContaining({
      newObjectId: "memory-new",
      evidenceId: "evidence-created-with-memory",
      signal,
      context: {
        source_event_anchor: {
          event_type: SignalEventType.SOUL_SIGNAL_EMITTED,
          event_id: emitted!.event_id,
          occurred_at: "2026-07-16T12:34:56.000Z"
        }
      }
    }));
    expect(emitted!.event_id).not.toBe("host-receipt-should-not-be-the-anchor");
  });

  it("defers when the persisted memory evidence link has no capsule anchored to the canonical emission", async () => {
    const signal = buildSignal();
    const rows = await emitCanonicalSignalEnvelope(signal);
    const replaySignalRefs = vi.fn(async () => []);
    const port = createGardenSignalRefReplayPort({
      eventLogRepo: { append: vi.fn(), queryByEntity: vi.fn(async () => rows) },
      evidenceCapsuleLookup: {
        findByIds: vi.fn(async () => [{
          object_id: "evidence-with-mismatched-anchor",
          event_anchor: {
            event_type: SignalEventType.SOUL_SIGNAL_EMITTED,
            event_id: "another-signal-emission",
            occurred_at: "2026-07-16T12:34:56.000Z"
          }
        }])
      },
      materializationRouter: { replaySignalRefs }
    });

    await expect(port.replaySignalRefs({
      newMemoryId: "memory-new",
      memoryEvidenceIds: ["evidence-with-mismatched-anchor"],
      signal
    })).rejects.toThrow(
      "BULK_ENRICH signal-ref replay deferred because the materialized memory has no uniquely anchored evidence capsule."
    );
    expect(replaySignalRefs).not.toHaveBeenCalled();
  });

  it("defers when more than one persisted memory evidence capsule matches the canonical emission", async () => {
    const signal = buildSignal();
    const rows = await emitCanonicalSignalEnvelope(signal);
    const emitted = rows.find((entry) => entry.event_type === SignalEventType.SOUL_SIGNAL_EMITTED);
    expect(emitted).toBeDefined();
    const replaySignalRefs = vi.fn(async () => []);
    const port = createGardenSignalRefReplayPort({
      eventLogRepo: { append: vi.fn(), queryByEntity: vi.fn(async () => rows) },
      evidenceCapsuleLookup: {
        findByIds: vi.fn(async () => ["evidence-a", "evidence-b"].map((object_id) => ({
          object_id,
          event_anchor: {
            event_type: SignalEventType.SOUL_SIGNAL_EMITTED,
            event_id: emitted!.event_id,
            occurred_at: "2026-07-16T12:34:56.000Z"
          }
        })))
      },
      materializationRouter: { replaySignalRefs }
    });

    await expect(port.replaySignalRefs({
      newMemoryId: "memory-new",
      memoryEvidenceIds: ["evidence-a", "evidence-b"],
      signal
    })).rejects.toThrow(
      "BULK_ENRICH signal-ref replay deferred because the materialized memory has no uniquely anchored evidence capsule."
    );
    expect(replaySignalRefs).not.toHaveBeenCalled();
  });

  it("throws a retryable defer when the unique canonical admission envelope is missing", async () => {
    const replaySignalRefs = vi.fn(async () => []);
    const port = createGardenSignalRefReplayPort({
      eventLogRepo: { append: vi.fn(), queryByEntity: vi.fn(async () => []) },
      evidenceCapsuleLookup: { findByIds: vi.fn(async () => []) },
      materializationRouter: { replaySignalRefs }
    });

    await expect(port.replaySignalRefs({
      newMemoryId: "memory-new",
      memoryEvidenceIds: ["evidence-created-with-memory"],
      signal: buildSignal()
    })).rejects.toThrow(
      "BULK_ENRICH signal-ref replay deferred because the canonical signal emission anchor is unavailable."
    );
    expect(replaySignalRefs).not.toHaveBeenCalled();
  });
});
