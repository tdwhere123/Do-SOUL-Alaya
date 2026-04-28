import { describe, expect, it } from "vitest";
import {
  deriveTrustSummary,
  recordSessionEvent,
  validateContextDeliveryRecord,
  validateUsageProofRecord
} from "../session/index.js";
import type {
  ContextDeliveryRecord,
  MemorySessionEvent,
  UsageProofRecord
} from "../session/index.js";
import { AlayaValidationError } from "../runtime/audit-types.js";

const now = "2026-04-28T00:00:00.000Z";

describe("session audit and trust", () => {
  it("keeps installed, configured, skipped, delivered, used, mixed, and unverifiable states distinct", () => {
    expect(deriveTrustSummary([event("installed")]).state).toBe("installed");
    expect(deriveTrustSummary([event("installed"), event("configured")]).state).toBe("configured");
    expect(deriveTrustSummary([event("installed"), event("configured"), deliveryEvent(skippedDelivery("delivery-skipped"))]).state).toBe("skipped");
    expect(deriveTrustSummary([event("installed"), event("configured"), deliveryEvent(delivery("delivery-delivered"))]).state).toBe("delivered");

    expect(deriveTrustSummary([
      event("installed"),
      event("configured"),
      deliveryEvent(delivery("delivery-used")),
      proofEvent(proof("proof-used", "explicit"))
    ])).toMatchObject({
      state: "used",
      delivered_count: 1,
      used_proof_count: 1,
      delivered_memory_ids: ["memory-a"],
      used_memory_ids: ["memory-a"]
    });

    expect(deriveTrustSummary([
      deliveryEvent(delivery("delivery-lineage")),
      proofEvent(proof("proof-lineage", "explicit"))
    ])).toMatchObject({
      delivery_evidence_refs: ["audit:context-pack-delivery"],
      delivery_source_refs: ["runtime:context-pack"],
      usage_proof_ids: ["proof-lineage"],
      usage_proof_evidence_refs: ["audit:usage-proof"],
      usage_proof_source_refs: ["runtime:usage-proof"]
    });

    expect(deriveTrustSummary([
      deliveryEvent(delivery("delivery-accepted")),
      proofEvent(proof("proof-accepted", "accepted"))
    ])).toMatchObject({
      state: "used",
      used_proof_count: 1
    });

    expect(deriveTrustSummary([
      event("installed"),
      event("configured"),
      deliveryEvent(delivery("delivery-mixed", ["memory-a", "memory-b"])),
      proofEvent(proof("proof-mixed", "explicit", ["memory-a"]))
    ])).toMatchObject({
      state: "mixed",
      unproved_memory_ids: ["memory-b"]
    });

    expect(deriveTrustSummary([proofEvent(proof("proof-unverifiable", "weak"))])).toMatchObject({
      state: "unverifiable",
      reasons: expect.arrayContaining(["missing_delivery_for_usage_proof"])
    });
  });

  it("does not infer used from delivery alone and keeps weak proof below full used", () => {
    const deliveredOnly = deriveTrustSummary([
      event("installed"),
      event("configured"),
      deliveryEvent(delivery("delivery-only"))
    ]);

    expect(deliveredOnly.state).toBe("delivered");
    expect(deliveredOnly.used_proof_count).toBe(0);
    expect(deliveredOnly.reasons).toContain("delivered_context_without_usage_proof");

    const weak = deriveTrustSummary([
      deliveryEvent(delivery("delivery-weak")),
      proofEvent(proof("proof-weak", "weak"))
    ]);

    expect(weak.state).toBe("mixed");
    expect(weak.used_proof_count).toBe(0);
    expect(weak.weak_proof_count).toBe(1);
    expect(weak.reasons).toContain("weak_usage_proof_not_full_use");
  });

  it("validates delivery and proof records with auditable source and evidence links", () => {
    expect(validateContextDeliveryRecord(delivery("delivery-valid"))).toEqual(delivery("delivery-valid"));
    expect(validateUsageProofRecord(proof("proof-valid", "explicit"))).toEqual(proof("proof-valid", "explicit"));

    expect(() => validateContextDeliveryRecord({
      ...delivery("delivery-invalid"),
      evidence_refs: []
    })).toThrow(AlayaValidationError);

    expect(() => validateUsageProofRecord({
      ...proof("proof-invalid", "explicit"),
      source_ref: ""
    })).toThrow(AlayaValidationError);
  });

  it("deduplicates repeated event ids and derives replay-stable summaries", () => {
    const first = deliveryEvent(delivery("delivery-replay"));
    const duplicate = { ...first };
    const proofRecord = proofEvent(proof("proof-replay", "explicit"));

    const replayed = [first, duplicate, proofRecord].reduce<readonly MemorySessionEvent[]>(
      (events, next) => recordSessionEvent(events, next),
      []
    );

    expect(replayed).toHaveLength(2);
    expect(deriveTrustSummary(replayed)).toEqual(deriveTrustSummary([proofRecord, first, duplicate]));
  });

  it("rejects duplicate event ids when the replay payload conflicts", () => {
    const first = deliveryEvent(delivery("delivery-conflict"));
    const conflicting = {
      ...first,
      workspace_id: "workspace-other"
    };

    expect(() => recordSessionEvent([first], conflicting)).toThrow(AlayaValidationError);
  });

  it("handles duplicate and late terminal events deterministically without corrupting trust", () => {
    const finished = terminalEvent("terminal-finished", "completed", "2026-04-28T00:01:00.000Z");
    const failed = terminalEvent("terminal-failed", "failed", "2026-04-28T00:02:00.000Z");
    const duplicateFailed = terminalEvent("terminal-failed-duplicate", "failed", "2026-04-28T00:03:00.000Z");

    const forward = deriveTrustSummary([finished, failed, duplicateFailed]);
    const reverse = deriveTrustSummary([duplicateFailed, failed, finished]);

    expect(forward.terminal).toMatchObject({
      event_id: "terminal-failed",
      status: "failed"
    });
    expect(reverse.terminal).toEqual(forward.terminal);
    expect(forward.late_terminal_event_ids).toEqual(["terminal-failed-duplicate", "terminal-finished"]);
    expect(forward.state).toBe("unverifiable");
    expect(forward.reasons).toContain("terminal_failed");
  });

  it("accepts explicit proof after terminal only with a late proof marker", () => {
    const summary = deriveTrustSummary([
      deliveryEvent(delivery("delivery-late-proof", ["memory-a"], "2026-04-28T00:00:30.000Z")),
      terminalEvent("terminal-completed", "completed", "2026-04-28T00:01:00.000Z"),
      proofEvent(proof("proof-late", "explicit", ["memory-a"], "2026-04-28T00:01:30.000Z"))
    ]);

    expect(summary).toMatchObject({
      state: "used",
      late_usage_proof_ids: ["proof-late"],
      reasons: expect.arrayContaining(["usage_proof_after_terminal"])
    });
  });
});

function event(type: "installed" | "configured" | "session_started" | "context_requested"): MemorySessionEvent {
  return {
    type,
    event_id: `event-${type}`,
    session_id: "session-1",
    run_id: "run-1",
    workspace_id: "workspace-1",
    agent_target: "codex",
    profile_scope: "project",
    activation_mode: "manual",
    recorded_at: now,
    source_ref: "operator:test",
    evidence_refs: ["audit:test"]
  };
}

function deliveryEvent(record: ContextDeliveryRecord): MemorySessionEvent {
  return {
    ...event("context_requested"),
    type: "context_delivered",
    event_id: `event-${record.delivery_id}`,
    recorded_at: record.delivered_at,
    delivery: record
  };
}

function proofEvent(record: UsageProofRecord): MemorySessionEvent {
  return {
    ...event("context_requested"),
    type: "usage_proof_recorded",
    event_id: `event-${record.proof_id}`,
    recorded_at: record.observed_at,
    usage_proof: record
  };
}

function terminalEvent(
  eventId: string,
  status: "completed" | "cancelled" | "failed" | "adapter_disconnected",
  recordedAt: string
): MemorySessionEvent {
  return {
    ...event("session_started"),
    type: "terminal_event",
    event_id: eventId,
    recorded_at: recordedAt,
    terminal_status: status,
    terminal_reason: `${status} terminal`
  };
}

function delivery(
  deliveryId: string,
  memoryIds: readonly string[] = ["memory-a"],
  deliveredAt = now
): ContextDeliveryRecord {
  return {
    delivery_id: deliveryId,
    session_id: "session-1",
    run_id: "run-1",
    workspace_id: "workspace-1",
    context_pack_id: "context-pack-1",
    target_agent: "codex",
    profile_scope: "project",
    activation_mode: "manual",
    outcome: "delivered",
    memory_ids: memoryIds,
    reason: null,
    delivered_at: deliveredAt,
    source_ref: "runtime:context-pack",
    evidence_refs: ["audit:context-pack-delivery"]
  };
}

function skippedDelivery(deliveryId: string): ContextDeliveryRecord {
  return {
    ...delivery(deliveryId, [], now),
    outcome: "skipped",
    reason: "skipped by policy"
  };
}

function proof(
  proofId: string,
  strength: "explicit" | "accepted" | "weak" | "unverifiable" | "negative",
  memoryIds: readonly string[] = ["memory-a"],
  observedAt = now
): UsageProofRecord {
  return {
    proof_id: proofId,
    session_id: "session-1",
    run_id: "run-1",
    workspace_id: "workspace-1",
    context_pack_id: "context-pack-1",
    memory_ids: memoryIds,
    proof_strength: strength,
    proof_source: "agent_transcript",
    confidence: strength === "weak" ? 0.4 : 0.95,
    observed_at: observedAt,
    summary: `${strength} proof`,
    source_ref: "runtime:usage-proof",
    evidence_refs: ["audit:usage-proof"]
  };
}
