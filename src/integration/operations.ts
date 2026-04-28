import { AlayaValidationError } from "../runtime/audit-types.js";
import type {
  AlayaRuntimePort,
  AuditedContextPackInput,
  AuditedMemorySessionEventInput,
  AuditedProposalRecordInput,
  AuditedProviderSelectionInput,
  AuditedRecallContextInput,
  AuditedTrustSummaryInput
} from "../runtime/types.js";

export type AlayaIntegrationRuntimeBoundary = Pick<
  AlayaRuntimePort,
  | "assembleRecallContext"
  | "recordContextPack"
  | "selectProvider"
  | "recordProposal"
  | "recordMemorySessionEvent"
  | "generateTrustSummary"
  | "doctor"
>;

export const integrationOperationIds = [
  "assemble_recall_context",
  "record_context_pack",
  "select_provider",
  "record_proposal",
  "record_memory_session_event",
  "generate_trust_summary",
  "doctor"
] as const;

export type IntegrationOperationId = (typeof integrationOperationIds)[number];

export const integrationCapabilities = [
  "recall_context",
  "context_pack_recording",
  "provider_selection",
  "proposal_recording",
  "session_audit",
  "trust_summary",
  "doctor_status"
] as const;

export type IntegrationCapability = (typeof integrationCapabilities)[number];

export const integrationStrictnessModes = [
  "read_only",
  "audit_required",
  "governance_required",
  "fail_closed_capable"
] as const;

export type IntegrationStrictnessMode = (typeof integrationStrictnessModes)[number];

export interface IntegrationStrictnessMetadata {
  readonly mode: IntegrationStrictnessMode;
  readonly auditRequired: boolean;
  readonly governanceBoundary: "runtime";
  readonly runtimeBoundary: "AlayaRuntimePort";
  readonly strictActivation: "not_applicable" | "explicit_only";
}

export interface IntegrationOperationDescriptor<T extends IntegrationOperationId = IntegrationOperationId> {
  readonly operationId: T;
  readonly runtimeMethod: keyof AlayaIntegrationRuntimeBoundary;
  readonly capability: IntegrationCapability;
  readonly strictness: IntegrationStrictnessMetadata;
  readonly inputContract: string;
  readonly resultContract: string;
  readonly durableTruthProduced: false;
  readonly description: string;
}

export interface IntegrationOperationInputMap {
  readonly assemble_recall_context: AuditedRecallContextInput;
  readonly record_context_pack: AuditedContextPackInput;
  readonly select_provider: AuditedProviderSelectionInput;
  readonly record_proposal: AuditedProposalRecordInput;
  readonly record_memory_session_event: AuditedMemorySessionEventInput;
  readonly generate_trust_summary: AuditedTrustSummaryInput;
  readonly doctor: undefined;
}

export type IntegrationOperationResultMap = {
  readonly assemble_recall_context: Awaited<ReturnType<AlayaIntegrationRuntimeBoundary["assembleRecallContext"]>>;
  readonly record_context_pack: Awaited<ReturnType<AlayaIntegrationRuntimeBoundary["recordContextPack"]>>;
  readonly select_provider: Awaited<ReturnType<AlayaIntegrationRuntimeBoundary["selectProvider"]>>;
  readonly record_proposal: Awaited<ReturnType<AlayaIntegrationRuntimeBoundary["recordProposal"]>>;
  readonly record_memory_session_event: Awaited<ReturnType<AlayaIntegrationRuntimeBoundary["recordMemorySessionEvent"]>>;
  readonly generate_trust_summary: Awaited<ReturnType<AlayaIntegrationRuntimeBoundary["generateTrustSummary"]>>;
  readonly doctor: Awaited<ReturnType<AlayaIntegrationRuntimeBoundary["doctor"]>>;
};

const runtimeGovernanceStrictness = {
  auditRequired: true,
  governanceBoundary: "runtime",
  runtimeBoundary: "AlayaRuntimePort",
  strictActivation: "not_applicable"
} as const satisfies Omit<IntegrationStrictnessMetadata, "mode">;

export const integrationOperationDescriptors = [
  {
    operationId: "assemble_recall_context",
    runtimeMethod: "assembleRecallContext",
    capability: "recall_context",
    strictness: {
      ...runtimeGovernanceStrictness,
      mode: "governance_required"
    },
    inputContract: "AuditedRecallContextInput",
    resultContract: "AuditedMutationResult<ContextPack>",
    durableTruthProduced: false,
    description: "Assemble an audited runtime context pack through the recall/runtime boundary."
  },
  {
    operationId: "record_context_pack",
    runtimeMethod: "recordContextPack",
    capability: "context_pack_recording",
    strictness: {
      ...runtimeGovernanceStrictness,
      mode: "audit_required"
    },
    inputContract: "AuditedContextPackInput",
    resultContract: "AuditedMutationResult<ContextPack>",
    durableTruthProduced: false,
    description: "Record a context pack as runtime projection state without promoting it to durable truth."
  },
  {
    operationId: "select_provider",
    runtimeMethod: "selectProvider",
    capability: "provider_selection",
    strictness: {
      ...runtimeGovernanceStrictness,
      mode: "fail_closed_capable",
      strictActivation: "explicit_only"
    },
    inputContract: "AuditedProviderSelectionInput",
    resultContract: "AuditedMutationResult<ProviderSelectionResult>",
    durableTruthProduced: false,
    description: "Select a provider through runtime policy, including fail-closed behavior when requested."
  },
  {
    operationId: "record_proposal",
    runtimeMethod: "recordProposal",
    capability: "proposal_recording",
    strictness: {
      ...runtimeGovernanceStrictness,
      mode: "governance_required"
    },
    inputContract: "AuditedProposalRecordInput",
    resultContract: "AuditedMutationResult<ProposalValidationResult>",
    durableTruthProduced: false,
    description: "Record an agent/provider proposal as auditable non-durable candidate state."
  },
  {
    operationId: "record_memory_session_event",
    runtimeMethod: "recordMemorySessionEvent",
    capability: "session_audit",
    strictness: {
      ...runtimeGovernanceStrictness,
      mode: "audit_required"
    },
    inputContract: "AuditedMemorySessionEventInput",
    resultContract: "AuditedMutationResult<MemorySessionEvent>",
    durableTruthProduced: false,
    description: "Record installation, configuration, delivery, usage, and terminal session events."
  },
  {
    operationId: "generate_trust_summary",
    runtimeMethod: "generateTrustSummary",
    capability: "trust_summary",
    strictness: {
      ...runtimeGovernanceStrictness,
      mode: "audit_required"
    },
    inputContract: "AuditedTrustSummaryInput",
    resultContract: "AuditedMutationResult<TrustSummary>",
    durableTruthProduced: false,
    description: "Generate an audited session trust summary from runtime/session evidence."
  },
  {
    operationId: "doctor",
    runtimeMethod: "doctor",
    capability: "doctor_status",
    strictness: {
      auditRequired: false,
      governanceBoundary: "runtime",
      mode: "read_only",
      runtimeBoundary: "AlayaRuntimePort",
      strictActivation: "not_applicable"
    },
    inputContract: "undefined",
    resultContract: "DoctorReport",
    durableTruthProduced: false,
    description: "Read runtime/package health status without writing durable memory truth."
  }
] as const satisfies readonly IntegrationOperationDescriptor[];

export function listIntegrationOperationDescriptors(): readonly IntegrationOperationDescriptor[] {
  return integrationOperationDescriptors;
}

export function findIntegrationOperationDescriptor(
  operationId: string
): IntegrationOperationDescriptor | null {
  return integrationOperationDescriptors.find((descriptor) => descriptor.operationId === operationId) ?? null;
}

export function getIntegrationOperationDescriptor<T extends IntegrationOperationId>(
  operationId: T
): Extract<(typeof integrationOperationDescriptors)[number], { readonly operationId: T }> {
  const descriptor = findIntegrationOperationDescriptor(operationId);
  if (descriptor === null) {
    throw new AlayaValidationError(`Unsupported integration operation: ${operationId}.`);
  }
  return descriptor as Extract<(typeof integrationOperationDescriptors)[number], { readonly operationId: T }>;
}

export async function invokeIntegrationOperation<T extends IntegrationOperationId>(
  runtime: AlayaIntegrationRuntimeBoundary,
  operationId: T,
  input: IntegrationOperationInputMap[T]
): Promise<IntegrationOperationResultMap[T]> {
  switch (operationId) {
    case "assemble_recall_context":
      return await runtime.assembleRecallContext(
        requireInvocationInput(input as AuditedRecallContextInput | undefined, operationId)
      ) as IntegrationOperationResultMap[T];
    case "record_context_pack":
      return await runtime.recordContextPack(
        requireInvocationInput(input as AuditedContextPackInput | undefined, operationId)
      ) as IntegrationOperationResultMap[T];
    case "select_provider":
      return await runtime.selectProvider(
        requireInvocationInput(input as AuditedProviderSelectionInput | undefined, operationId)
      ) as IntegrationOperationResultMap[T];
    case "record_proposal":
      return await runtime.recordProposal(
        requireInvocationInput(input as AuditedProposalRecordInput | undefined, operationId)
      ) as IntegrationOperationResultMap[T];
    case "record_memory_session_event":
      return await runtime.recordMemorySessionEvent(
        requireInvocationInput(input as AuditedMemorySessionEventInput | undefined, operationId)
      ) as IntegrationOperationResultMap[T];
    case "generate_trust_summary":
      return await runtime.generateTrustSummary(
        requireInvocationInput(input as AuditedTrustSummaryInput | undefined, operationId)
      ) as IntegrationOperationResultMap[T];
    case "doctor":
      return await runtime.doctor() as IntegrationOperationResultMap[T];
    default:
      return assertNeverOperation(operationId);
  }
}

function requireInvocationInput<T>(input: T | undefined, operationId: string): T {
  if (input === undefined) {
    throw new AlayaValidationError(`Integration operation ${operationId} requires input.`);
  }
  return input;
}

function assertNeverOperation(operationId: never): never {
  throw new AlayaValidationError(`Unsupported integration operation: ${operationId}.`);
}
