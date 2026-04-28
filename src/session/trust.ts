import { AlayaValidationError } from "../runtime/audit-types.js";
import type {
  ContextDeliveryRecord,
  MemorySessionEvent,
  SessionTerminalStatus,
  TerminalEventSummary,
  TrustSummary,
  UsageProofRecord
} from "./types.js";
import { validateMemorySessionEvent } from "./validation.js";

export function recordSessionEvent(
  records: readonly MemorySessionEvent[],
  event: MemorySessionEvent
): readonly MemorySessionEvent[] {
  const validated = validateMemorySessionEvent(event);
  const existing = records.find((record) => record.event_id === validated.event_id);
  if (existing !== undefined) {
    if (stableJson(existing) !== stableJson(validated)) {
      throw new AlayaValidationError(`Duplicate session event id has conflicting payload: ${validated.event_id}`);
    }
    return records;
  }
  assertSameSession(records, validated);
  return [...records, validated];
}

export function deriveTrustSummary(records: readonly MemorySessionEvent[]): TrustSummary {
  const replayed = replayRecords(records);
  const events = [...replayed].sort(compareEvents);
  const firstEvent = events[0] ?? null;
  const deliveries = uniqueDeliveries(events);
  const proofs = uniqueProofs(events);
  const delivered = deliveries.filter((record) => record.outcome === "delivered");
  const skipped = deliveries.filter((record) => record.outcome === "skipped");
  const failedDeliveries = deliveries.filter((record) => record.outcome === "failed");
  const deliveredContextPackIds = sortedUnique(delivered.map((record) => record.context_pack_id));
  const deliveredContextPackIdSet = new Set(deliveredContextPackIds);
  const deliveredMemoryIds = sortedUnique(delivered.flatMap((record) => [...record.memory_ids]));
  const deliveredMemoryIdSet = new Set(deliveredMemoryIds);
  const terminal = deriveTerminal(events);
  const reasons: string[] = [];

  const usedMemoryIdSet = new Set<string>();
  let usedProofCount = 0;
  let weakProofCount = 0;
  let unverifiableProofCount = 0;

  for (const proofRecord of proofs) {
    const hasMatchingDelivery = deliveredContextPackIdSet.has(proofRecord.context_pack_id);
    if (!hasMatchingDelivery) {
      unverifiableProofCount += 1;
      reasons.push("missing_delivery_for_usage_proof");
    }

    if (proofRecord.proof_strength === "weak") {
      weakProofCount += 1;
      if (hasMatchingDelivery) {
        reasons.push("weak_usage_proof_not_full_use");
      }
      continue;
    }

    if (proofRecord.proof_strength === "unverifiable" || proofRecord.proof_strength === "negative") {
      unverifiableProofCount += 1;
      reasons.push("unverifiable_usage_proof");
      continue;
    }

    if (!hasMatchingDelivery) {
      continue;
    }

    const usedMemoryIds = proofRecord.memory_ids.filter((memoryId) => deliveredMemoryIdSet.has(memoryId));
    if (usedMemoryIds.length === 0) {
      unverifiableProofCount += 1;
      reasons.push("proof_references_undelivered_memory");
      continue;
    }

    usedProofCount += 1;
    usedMemoryIds.forEach((memoryId) => usedMemoryIdSet.add(memoryId));
    if (usedMemoryIds.length < proofRecord.memory_ids.length) {
      unverifiableProofCount += 1;
      reasons.push("proof_references_undelivered_memory");
    }
  }

  const usedMemoryIds = sortedUnique([...usedMemoryIdSet]);
  const unprovedMemoryIds = deliveredMemoryIds.filter((memoryId) => !usedMemoryIdSet.has(memoryId));
  const lateUsageProofIds = deriveLateUsageProofIds(proofs, terminal.selected);

  if (delivered.length > 0 && proofs.length === 0) {
    reasons.push("delivered_context_without_usage_proof");
  }
  if (delivered.length > 0 && unprovedMemoryIds.length > 0 && proofs.length > 0) {
    reasons.push("delivered_memory_without_usage_proof");
  }
  if (skipped.length > 0) {
    reasons.push("context_delivery_skipped");
  }
  if (failedDeliveries.length > 0) {
    reasons.push("context_delivery_failed");
  }
  if (terminal.selected === null && (delivered.length > 0 || proofs.length > 0 || hasEvent(events, "session_started"))) {
    reasons.push("missing_terminal");
  }
  if (terminal.selected?.status === "failed") {
    reasons.push("terminal_failed");
  }
  if (terminal.selected?.status === "cancelled") {
    reasons.push("terminal_cancelled");
  }
  if (terminal.selected?.status === "adapter_disconnected") {
    reasons.push("adapter_disconnected");
  }
  if (terminal.lateIds.length > 0) {
    reasons.push("late_terminal_event");
  }
  if (lateUsageProofIds.length > 0) {
    reasons.push("usage_proof_after_terminal");
  }

  return {
    state: deriveState({
      installed: hasEvent(events, "installed"),
      configured: hasEvent(events, "configured"),
      deliveredMemoryCount: deliveredMemoryIds.length,
      skippedCount: skipped.length,
      usedMemoryCount: usedMemoryIds.length,
      unprovedMemoryCount: unprovedMemoryIds.length,
      weakProofCount,
      unverifiableProofCount,
      proofCount: proofs.length
    }),
    session_id: firstEvent?.session_id ?? null,
    run_id: firstEvent?.run_id ?? null,
    workspace_id: firstEvent?.workspace_id ?? null,
    installed: hasEvent(events, "installed"),
    configured: hasEvent(events, "configured"),
    session_started: hasEvent(events, "session_started"),
    delivered_count: delivered.length,
    skipped_count: skipped.length,
    failed_delivery_count: failedDeliveries.length,
    used_proof_count: usedProofCount,
    weak_proof_count: weakProofCount,
    unverifiable_proof_count: unverifiableProofCount,
    delivered_context_pack_ids: deliveredContextPackIds,
    delivered_memory_ids: deliveredMemoryIds,
    used_memory_ids: usedMemoryIds,
    unproved_memory_ids: unprovedMemoryIds,
    skipped_context_pack_ids: sortedUnique(skipped.map((record) => record.context_pack_id)),
    delivery_evidence_refs: sortedUnique(deliveries.flatMap((record) => [...record.evidence_refs])),
    delivery_source_refs: sortedUnique(deliveries.map((record) => record.source_ref)),
    usage_proof_ids: sortedUnique(proofs.map((record) => record.proof_id)),
    usage_proof_evidence_refs: sortedUnique(proofs.flatMap((record) => [...record.evidence_refs])),
    usage_proof_source_refs: sortedUnique(proofs.map((record) => record.source_ref)),
    terminal: terminal.selected,
    late_terminal_event_ids: terminal.lateIds,
    late_usage_proof_ids: lateUsageProofIds,
    reasons: sortedUnique(reasons),
    generated_from: {
      event_count: events.length,
      delivery_count: deliveries.length,
      proof_count: proofs.length
    }
  };
}

function replayRecords(records: readonly MemorySessionEvent[]): readonly MemorySessionEvent[] {
  return records.reduce<readonly MemorySessionEvent[]>(
    (events, next) => recordSessionEvent(events, next),
    []
  );
}

function assertSameSession(records: readonly MemorySessionEvent[], event: MemorySessionEvent): void {
  const first = records[0];
  if (first === undefined) {
    return;
  }
  if (
    first.session_id !== event.session_id ||
    first.run_id !== event.run_id ||
    first.workspace_id !== event.workspace_id
  ) {
    throw new AlayaValidationError("Session audit records must share session_id, run_id, and workspace_id.");
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`);
  return `{${entries.join(",")}}`;
}

function uniqueDeliveries(events: readonly MemorySessionEvent[]): readonly ContextDeliveryRecord[] {
  const byId = new Map<string, ContextDeliveryRecord>();
  for (const event of events) {
    if (event.type === "context_delivered" && !byId.has(event.delivery.delivery_id)) {
      byId.set(event.delivery.delivery_id, event.delivery);
    }
  }
  return [...byId.values()].sort(compareDeliveries);
}

function uniqueProofs(events: readonly MemorySessionEvent[]): readonly UsageProofRecord[] {
  const byId = new Map<string, UsageProofRecord>();
  for (const event of events) {
    if (event.type === "usage_proof_recorded" && !byId.has(event.usage_proof.proof_id)) {
      byId.set(event.usage_proof.proof_id, event.usage_proof);
    }
  }
  return [...byId.values()].sort(compareProofs);
}

function deriveTerminal(events: readonly MemorySessionEvent[]): {
  readonly selected: TerminalEventSummary | null;
  readonly lateIds: readonly string[];
} {
  const terminalEvents = events
    .filter((event): event is Extract<MemorySessionEvent, { type: "terminal_event" }> => event.type === "terminal_event")
    .sort(compareTerminalEvents);

  const selectedEvent = terminalEvents[0];
  if (selectedEvent === undefined) {
    return { selected: null, lateIds: [] };
  }

  return {
    selected: {
      event_id: selectedEvent.event_id,
      status: selectedEvent.terminal_status,
      reason: selectedEvent.terminal_reason,
      recorded_at: selectedEvent.recorded_at
    },
    lateIds: terminalEvents.slice(1).map((event) => event.event_id)
  };
}

function deriveLateUsageProofIds(
  proofs: readonly UsageProofRecord[],
  terminal: TerminalEventSummary | null
): readonly string[] {
  if (terminal === null) {
    return [];
  }
  return proofs
    .filter((proofRecord) => compareText(proofRecord.observed_at, terminal.recorded_at) > 0)
    .map((proofRecord) => proofRecord.proof_id)
    .sort(compareText);
}

function deriveState(input: {
  readonly installed: boolean;
  readonly configured: boolean;
  readonly deliveredMemoryCount: number;
  readonly skippedCount: number;
  readonly usedMemoryCount: number;
  readonly unprovedMemoryCount: number;
  readonly weakProofCount: number;
  readonly unverifiableProofCount: number;
  readonly proofCount: number;
}): TrustSummary["state"] {
  if (input.deliveredMemoryCount > 0) {
    if (
      input.usedMemoryCount === input.deliveredMemoryCount &&
      input.unprovedMemoryCount === 0 &&
      input.weakProofCount === 0 &&
      input.unverifiableProofCount === 0
    ) {
      return "used";
    }
    if (input.usedMemoryCount > 0 || input.weakProofCount > 0 || input.unverifiableProofCount > 0 || input.proofCount > 0) {
      return "mixed";
    }
    return "delivered";
  }
  if (input.proofCount > 0 || input.unverifiableProofCount > 0) {
    return "unverifiable";
  }
  if (input.skippedCount > 0) {
    return "skipped";
  }
  if (input.configured) {
    return "configured";
  }
  if (input.installed) {
    return "installed";
  }
  return "unverifiable";
}

function hasEvent(events: readonly MemorySessionEvent[], type: MemorySessionEvent["type"]): boolean {
  return events.some((event) => event.type === type);
}

function compareEvents(left: MemorySessionEvent, right: MemorySessionEvent): number {
  return compareText(left.recorded_at, right.recorded_at) || compareText(left.event_id, right.event_id);
}

function compareDeliveries(left: ContextDeliveryRecord, right: ContextDeliveryRecord): number {
  return compareText(left.delivered_at, right.delivered_at) || compareText(left.delivery_id, right.delivery_id);
}

function compareProofs(left: UsageProofRecord, right: UsageProofRecord): number {
  return compareText(left.observed_at, right.observed_at) || compareText(left.proof_id, right.proof_id);
}

function compareTerminalEvents(
  left: Extract<MemorySessionEvent, { type: "terminal_event" }>,
  right: Extract<MemorySessionEvent, { type: "terminal_event" }>
): number {
  return terminalRank(right.terminal_status) - terminalRank(left.terminal_status) ||
    compareText(left.recorded_at, right.recorded_at) ||
    compareText(left.event_id, right.event_id);
}

function terminalRank(status: SessionTerminalStatus): number {
  switch (status) {
    case "failed":
      return 4;
    case "adapter_disconnected":
      return 3;
    case "cancelled":
      return 2;
    case "completed":
      return 1;
  }
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(compareText);
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right);
}
