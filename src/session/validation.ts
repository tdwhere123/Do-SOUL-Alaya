import {
  assertIsoDatetime,
  assertObject,
  assertOneOf,
  assertText,
  assertTextArray,
  assertUnitInterval
} from "../foundation/validation.js";
import { AlayaValidationError } from "../runtime/audit-types.js";
import type {
  ContextDeliveryRecord,
  MemorySessionEvent,
  UsageProofRecord
} from "./types.js";
import {
  contextDeliveryOutcomes,
  memorySessionEventTypes,
  sessionTerminalStatuses,
  usageProofStrengths
} from "./types.js";

export function validateContextDeliveryRecord(record: ContextDeliveryRecord): ContextDeliveryRecord {
  assertObject(record, "ContextDeliveryRecord");
  assertText(record.delivery_id, "delivery_id");
  assertText(record.session_id, "session_id");
  assertText(record.run_id, "run_id");
  assertText(record.workspace_id, "workspace_id");
  assertText(record.context_pack_id, "context_pack_id");
  assertText(record.target_agent, "target_agent");
  assertText(record.profile_scope, "profile_scope");
  assertText(record.activation_mode, "activation_mode");
  assertOneOf(record.outcome, contextDeliveryOutcomes, "outcome");
  assertTextArray(record.memory_ids, "memory_ids", { nonEmpty: record.outcome === "delivered" });
  if (record.outcome === "delivered" && record.reason !== null) {
    assertText(record.reason, "reason");
  }
  if (record.outcome !== "delivered") {
    assertText(record.reason, "reason");
  }
  assertIsoDatetime(record.delivered_at, "delivered_at");
  assertText(record.source_ref, "source_ref");
  assertTextArray(record.evidence_refs, "evidence_refs", { nonEmpty: true });
  return record;
}

export function validateUsageProofRecord(record: UsageProofRecord): UsageProofRecord {
  assertObject(record, "UsageProofRecord");
  assertText(record.proof_id, "proof_id");
  assertText(record.session_id, "session_id");
  assertText(record.run_id, "run_id");
  assertText(record.workspace_id, "workspace_id");
  assertText(record.context_pack_id, "context_pack_id");
  assertTextArray(record.memory_ids, "memory_ids", { nonEmpty: true });
  assertOneOf(record.proof_strength, usageProofStrengths, "proof_strength");
  assertText(record.proof_source, "proof_source");
  assertUnitInterval(record.confidence, "confidence");
  assertIsoDatetime(record.observed_at, "observed_at");
  assertText(record.summary, "summary");
  assertText(record.source_ref, "source_ref");
  assertTextArray(record.evidence_refs, "evidence_refs", { nonEmpty: true });
  return record;
}

export function validateMemorySessionEvent(event: MemorySessionEvent): MemorySessionEvent {
  assertObject(event, "MemorySessionEvent");
  assertOneOf(event.type, memorySessionEventTypes, "type");
  assertText(event.event_id, "event_id");
  assertText(event.session_id, "session_id");
  assertText(event.run_id, "run_id");
  assertText(event.workspace_id, "workspace_id");
  assertText(event.agent_target, "agent_target");
  assertText(event.profile_scope, "profile_scope");
  assertText(event.activation_mode, "activation_mode");
  assertIsoDatetime(event.recorded_at, "recorded_at");
  assertText(event.source_ref, "source_ref");
  assertTextArray(event.evidence_refs, "evidence_refs", { nonEmpty: true });

  switch (event.type) {
    case "context_delivered":
      validateContextDeliveryRecord(event.delivery);
      assertMatchingIdentity(event, event.delivery, "delivery");
      assertSame(event.agent_target, event.delivery.target_agent, "delivery.target_agent");
      assertSame(event.profile_scope, event.delivery.profile_scope, "delivery.profile_scope");
      assertSame(event.activation_mode, event.delivery.activation_mode, "delivery.activation_mode");
      break;
    case "usage_proof_recorded":
      validateUsageProofRecord(event.usage_proof);
      assertMatchingIdentity(event, event.usage_proof, "usage_proof");
      break;
    case "proposal_recorded":
      assertText(event.proposal_id, "proposal_id");
      break;
    case "terminal_event":
      assertOneOf(event.terminal_status, sessionTerminalStatuses, "terminal_status");
      assertText(event.terminal_reason, "terminal_reason");
      break;
    case "trust_summary_generated":
      assertText(event.summary_id, "summary_id");
      break;
    case "installed":
    case "configured":
    case "session_started":
    case "context_requested":
      break;
  }

  return event;
}

function assertMatchingIdentity(
  event: MemorySessionEvent,
  record: Pick<ContextDeliveryRecord | UsageProofRecord, "session_id" | "run_id" | "workspace_id">,
  label: string
): void {
  assertSame(event.session_id, record.session_id, `${label}.session_id`);
  assertSame(event.run_id, record.run_id, `${label}.run_id`);
  assertSame(event.workspace_id, record.workspace_id, `${label}.workspace_id`);
}

function assertSame(left: string, right: string, label: string): void {
  if (left !== right) {
    throw new AlayaValidationError(`${label} must match the session event envelope.`);
  }
}
