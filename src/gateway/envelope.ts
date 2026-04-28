import type { AlayaOperationName } from "../cli/fallback.js";
import type { ProposalRecord, ProposalValidationResult, ProviderSelectionResult } from "../provider/index.js";
import { providerSelectionStatuses, validateProposalRecord } from "../provider/index.js";
import type { ContextDeliveryRecord, MemorySessionEvent } from "../session/index.js";
import { validateContextDeliveryRecord, validateMemorySessionEvent } from "../session/index.js";
import {
  assertIsoDatetime,
  assertObject,
  assertOneOf,
  assertText
} from "../foundation/validation.js";
import { AlayaValidationError } from "../runtime/audit-types.js";
import { redactString } from "../runtime/redaction.js";

const gatewayOperationNames = [
  "doctor.status",
  "governance.bypass.detected",
  "provider.proposal.record",
  "provider.selection.decide",
  "recall.context.assemble",
  "recall.context_pack.record",
  "session.event.record",
  "session.trust_summary.generate"
] as const satisfies readonly AlayaOperationName[];

export interface GatewayBenchmarkProfile {
  readonly profile_id: string;
  readonly gateway_strict?: boolean;
}

export interface GatewayModeInput {
  readonly strict?: boolean;
  readonly benchmarkProfile?: GatewayBenchmarkProfile | null;
}

export type GatewayModeResolution =
  | {
      readonly mode: "audit";
      readonly source: "default";
    }
  | {
      readonly mode: "strict";
      readonly source: "explicit_flag" | "benchmark_profile";
    };

export interface GatewayBypassInput {
  readonly detected: boolean;
  readonly attempted_operation: string;
  readonly reason: string;
  readonly recoverable?: boolean;
}

export interface GatewayEnvelopeInput extends GatewayModeInput {
  readonly operation: AlayaOperationName;
  readonly session: MemorySessionEvent;
  readonly context?: ContextDeliveryRecord | null;
  readonly provider?: ProviderSelectionResult | null;
  readonly proposal?: ProposalRecord | ProposalValidationResult | null;
  readonly bypass?: GatewayBypassInput | null;
  readonly target_agent: string;
  readonly recorded_at: string;
}

export interface GatewaySessionEvidenceLink {
  readonly event_id: string;
  readonly session_id: string;
  readonly run_id: string;
  readonly workspace_id: string;
  readonly event_type: MemorySessionEvent["type"];
  readonly activation_mode: string;
  readonly source_ref: string;
  readonly evidence_refs: readonly string[];
}

export interface GatewayContextEvidenceLink {
  readonly delivery_id: string;
  readonly context_pack_id: string;
  readonly outcome: ContextDeliveryRecord["outcome"];
  readonly memory_ids: readonly string[];
  readonly delivered_context_counts_as_usage_proof: false;
  readonly source_ref: string;
  readonly evidence_refs: readonly string[];
}

export interface GatewayProviderEvidenceLink {
  readonly decision_id: string;
  readonly status: ProviderSelectionResult["status"];
  readonly selected_provider_id: string | null;
  readonly degraded: boolean;
}

export interface GatewayProposalEvidenceLink {
  readonly proposal_id: string;
  readonly lifecycle_state: ProposalRecord["lifecycle_state"];
  readonly provider_decision_id: string | null;
  readonly durable_truth: false;
  readonly evidence_refs: readonly string[];
  readonly source_refs: readonly string[];
}

export interface GatewayEvidenceLinks {
  readonly session: GatewaySessionEvidenceLink;
  readonly context: GatewayContextEvidenceLink | null;
  readonly provider: GatewayProviderEvidenceLink | null;
  readonly proposal: GatewayProposalEvidenceLink | null;
}

export interface GatewayBypassResult {
  readonly detected: boolean;
  readonly attempted_operation: string | null;
  readonly reason: string | null;
  readonly recoverable: boolean;
}

export interface GatewayEnvelopeResult {
  readonly schema_version: 1;
  readonly operation: AlayaOperationName;
  readonly target_agent: string;
  readonly recorded_at: string;
  readonly mode: GatewayModeResolution;
  readonly action: "allowed" | "blocked";
  readonly blocked: boolean;
  readonly bypass: GatewayBypassResult;
  readonly evidence_links: GatewayEvidenceLinks;
  readonly audit_evidence_refs: readonly string[];
  readonly durable_truth_written: false;
  readonly counts_as_usage_proof: false;
}

export function resolveGatewayMode(input: GatewayModeInput): GatewayModeResolution {
  if (input.strict === true) {
    return {
      mode: "strict",
      source: "explicit_flag"
    };
  }
  if (input.benchmarkProfile?.gateway_strict === true) {
    return {
      mode: "strict",
      source: "benchmark_profile"
    };
  }
  return {
    mode: "audit",
    source: "default"
  };
}

export function evaluateGatewayEnvelope(input: GatewayEnvelopeInput): GatewayEnvelopeResult {
  validateGatewayEnvelopeInput(input);
  const mode = resolveGatewayMode(input);
  const bypass = normalizeBypass(input.bypass ?? null);
  const blocked = mode.mode === "strict" && bypass.detected;
  const evidenceLinks = linkGatewayEvidence(input);

  return {
    action: blocked ? "blocked" : "allowed",
    audit_evidence_refs: gatewayEvidenceRefs(evidenceLinks),
    blocked,
    bypass,
    counts_as_usage_proof: false,
    durable_truth_written: false,
    evidence_links: evidenceLinks,
    mode,
    operation: input.operation,
    recorded_at: input.recorded_at,
    schema_version: 1,
    target_agent: input.target_agent
  };
}

export function linkGatewayEvidence(input: Pick<
  GatewayEnvelopeInput,
  "context" | "proposal" | "provider" | "session"
>): GatewayEvidenceLinks {
  validateMemorySessionEvent(input.session);
  if (input.context !== undefined && input.context !== null) {
    validateContextDeliveryRecord(input.context);
    assertSameIdentity(input.session, input.context, "context");
  }
  if (input.proposal !== undefined && input.proposal !== null) {
    validateGatewayProposal(input.proposal);
  }
  if (input.provider !== undefined && input.provider !== null) {
    validateGatewayProvider(input.provider);
  }
  return {
    context: input.context === undefined || input.context === null ? null : linkContext(input.context),
    proposal: input.proposal === undefined || input.proposal === null ? null : linkProposal(input.proposal),
    provider: input.provider === undefined || input.provider === null ? null : linkProvider(input.provider),
    session: linkSession(input.session)
  };
}

function validateGatewayEnvelopeInput(input: GatewayEnvelopeInput): void {
  assertObject(input, "GatewayEnvelopeInput");
  assertOneOf(input.operation, gatewayOperationNames, "operation");
  assertText(input.target_agent, "target_agent");
  assertIsoDatetime(input.recorded_at, "recorded_at");
  validateMemorySessionEvent(input.session);
  if (input.session.agent_target !== input.target_agent) {
    throw new AlayaValidationError("gateway target_agent must match session agent_target.");
  }
  if (input.context !== undefined && input.context !== null) {
    validateContextDeliveryRecord(input.context);
    assertSameIdentity(input.session, input.context, "context");
    if (input.context.target_agent !== input.target_agent) {
      throw new AlayaValidationError("gateway context target_agent must match envelope target_agent.");
    }
  }
  if (input.provider !== undefined && input.provider !== null) {
    validateGatewayProvider(input.provider);
  }
  if (input.proposal !== undefined && input.proposal !== null) {
    validateGatewayProposal(input.proposal);
  }
}

function validateGatewayProvider(result: ProviderSelectionResult): void {
  assertObject(result, "ProviderSelectionResult");
  assertText(result.decision_id, "provider.decision_id");
  assertOneOf(result.status, providerSelectionStatuses, "provider.status");
  if (typeof result.degraded !== "boolean") {
    throw new AlayaValidationError("provider.degraded must be boolean.");
  }
}

function validateGatewayProposal(input: ProposalRecord | ProposalValidationResult): void {
  if ("proposal" in input) {
    assertObject(input, "ProposalValidationResult");
    if (typeof input.accepted !== "boolean") {
      throw new AlayaValidationError("proposal validation accepted must be boolean.");
    }
    if (!input.accepted) {
      throw new AlayaValidationError("gateway proposal evidence requires an accepted proposal validation result.");
    }
    if (validateProposalRecord(input.proposal).accepted !== true) {
      throw new AlayaValidationError("accepted proposal validation result must contain a valid proposal.");
    }
    return;
  }
  const result = validateProposalRecord(input);
  if (!result.accepted) {
    throw new AlayaValidationError("gateway proposal must pass proposal validation.");
  }
}

function assertSameIdentity(
  session: MemorySessionEvent,
  record: Pick<ContextDeliveryRecord, "session_id" | "run_id" | "workspace_id">,
  label: string
): void {
  if (session.session_id !== record.session_id) {
    throw new AlayaValidationError(`${label}.session_id must match gateway session.`);
  }
  if (session.run_id !== record.run_id) {
    throw new AlayaValidationError(`${label}.run_id must match gateway session.`);
  }
  if (session.workspace_id !== record.workspace_id) {
    throw new AlayaValidationError(`${label}.workspace_id must match gateway session.`);
  }
}

function normalizeBypass(input: GatewayBypassInput | null): GatewayBypassResult {
  if (input === null) {
    return {
      attempted_operation: null,
      detected: false,
      reason: null,
      recoverable: true
    };
  }
  return {
    attempted_operation: redactString(input.attempted_operation),
    detected: input.detected,
    reason: redactString(input.reason),
    recoverable: input.recoverable ?? true
  };
}

function linkSession(event: MemorySessionEvent): GatewaySessionEvidenceLink {
  return {
    activation_mode: event.activation_mode,
    event_id: event.event_id,
    event_type: event.type,
    evidence_refs: event.evidence_refs,
    run_id: event.run_id,
    session_id: event.session_id,
    source_ref: event.source_ref,
    workspace_id: event.workspace_id
  };
}

function linkContext(record: ContextDeliveryRecord): GatewayContextEvidenceLink {
  return {
    context_pack_id: record.context_pack_id,
    delivered_context_counts_as_usage_proof: false,
    delivery_id: record.delivery_id,
    evidence_refs: record.evidence_refs,
    memory_ids: record.memory_ids,
    outcome: record.outcome,
    source_ref: record.source_ref
  };
}

function linkProvider(result: ProviderSelectionResult): GatewayProviderEvidenceLink {
  return {
    decision_id: result.decision_id,
    degraded: result.degraded,
    selected_provider_id: result.selected_provider?.provider_id ?? null,
    status: result.status
  };
}

function linkProposal(input: ProposalRecord | ProposalValidationResult): GatewayProposalEvidenceLink {
  const proposal = "proposal" in input ? input.proposal : input;
  return {
    durable_truth: false,
    evidence_refs: proposal.evidence_refs,
    lifecycle_state: proposal.lifecycle_state,
    proposal_id: proposal.proposal_id,
    provider_decision_id: proposal.provider_decision_id,
    source_refs: proposal.source_refs
  };
}

function gatewayEvidenceRefs(links: GatewayEvidenceLinks): readonly string[] {
  return [
    `gateway:session:${links.session.session_id}`,
    ...(links.context === null ? [] : [`gateway:context:${links.context.context_pack_id}`]),
    ...(links.provider === null ? [] : [`gateway:provider:${links.provider.decision_id}`]),
    ...(links.proposal === null ? [] : [`gateway:proposal:${links.proposal.proposal_id}`])
  ];
}
