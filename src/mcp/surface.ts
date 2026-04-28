import {
  getIntegrationOperationDescriptor,
  invokeIntegrationOperation,
  type AlayaIntegrationRuntimeBoundary,
  type IntegrationCapability,
  type IntegrationOperationId,
  type IntegrationOperationInputMap,
  type IntegrationOperationResultMap,
  type IntegrationStrictnessMetadata
} from "../integration/operations.js";
import { AlayaValidationError } from "../runtime/audit-types.js";
import type { JsonObject } from "../runtime/json.js";
import { redactJsonObject } from "../runtime/redaction.js";

export type McpResourceClassification =
  | "durable_ontology"
  | "runtime_projection"
  | "audit_status";

export type McpTruthPlane =
  | "memory_ontology"
  | "runtime_control_plane"
  | "session_audit_status";

export interface McpResourceClassificationMetadata {
  readonly kind: McpResourceClassification;
  readonly truthPlane: McpTruthPlane;
  readonly durableTruth: boolean;
  readonly mayClaimDurableTruth: boolean;
  readonly description: string;
}

export interface McpToolDescriptor<T extends IntegrationOperationId = IntegrationOperationId> {
  readonly name: `alaya.${string}`;
  readonly operationId: T;
  readonly description: string;
  readonly capability: IntegrationCapability;
  readonly strictness: IntegrationStrictnessMetadata;
  readonly inputContract: string;
  readonly resultContract: string;
  readonly runtimeBoundary: "injected_runtime_operation";
  readonly durableTruthProduced: false;
}

export interface McpResourceDescriptor {
  readonly uriTemplate: `alaya://${string}`;
  readonly name: `alaya.${string}`;
  readonly description: string;
  readonly classification: McpResourceClassificationMetadata;
  readonly relatedOperationIds: readonly IntegrationOperationId[];
}

export interface McpPromptDescriptor {
  readonly name: `alaya.${string}`;
  readonly description: string;
  readonly capability: IntegrationCapability;
  readonly relatedOperationIds: readonly IntegrationOperationId[];
  readonly strictness: IntegrationStrictnessMetadata;
}

export interface AlayaMcpSurfaceDescriptor {
  readonly name: "do-soul-alaya";
  readonly protocol: "mcp-descriptor-no-sdk";
  readonly runtimeBoundary: "injected_runtime_operation";
  readonly tools: readonly McpToolDescriptor[];
  readonly resources: readonly McpResourceDescriptor[];
  readonly prompts: readonly McpPromptDescriptor[];
}

export const mcpToolDescriptors = [
  createMcpToolDescriptor(
    "alaya.recall.context.assemble",
    "assemble_recall_context",
    "Assemble a runtime context pack through Alaya recall governance."
  ),
  createMcpToolDescriptor(
    "alaya.context_pack.record",
    "record_context_pack",
    "Record a context pack as runtime projection state."
  ),
  createMcpToolDescriptor(
    "alaya.provider.select",
    "select_provider",
    "Select a provider through runtime policy and capability metadata."
  ),
  createMcpToolDescriptor(
    "alaya.proposal.record",
    "record_proposal",
    "Record a non-durable provider or agent proposal for governance review."
  ),
  createMcpToolDescriptor(
    "alaya.session.event.record",
    "record_memory_session_event",
    "Record auditable session activation, delivery, usage, or terminal events."
  ),
  createMcpToolDescriptor(
    "alaya.trust_summary.generate",
    "generate_trust_summary",
    "Generate a session trust summary from runtime audit evidence."
  ),
  createMcpToolDescriptor(
    "alaya.doctor.report",
    "doctor",
    "Read runtime/package status without mutating memory truth."
  )
] as const satisfies readonly McpToolDescriptor[];

export const mcpResourceDescriptors = [
  {
    uriTemplate: "alaya://ontology/memories/{object_id}",
    name: "alaya.ontology.memory",
    description: "Durable memory ontology record, when exposed by a runtime read operation.",
    classification: {
      kind: "durable_ontology",
      truthPlane: "memory_ontology",
      durableTruth: true,
      mayClaimDurableTruth: true,
      description: "Memory Ontology owns durable truth."
    },
    relatedOperationIds: []
  },
  {
    uriTemplate: "alaya://runtime/context-packs/{pack_id}",
    name: "alaya.runtime.context_pack",
    description: "Runtime context pack projection assembled for a turn.",
    classification: runtimeProjectionClassification(
      "Context packs deliver recall context but do not count as durable memory truth or usage proof."
    ),
    relatedOperationIds: ["assemble_recall_context", "record_context_pack"]
  },
  {
    uriTemplate: "alaya://runtime/projections/topology/{workspace_id}",
    name: "alaya.runtime.topology_projection",
    description: "Derived topology projection for inspection and runtime explanation.",
    classification: runtimeProjectionClassification(
      "Topology projections are derived views over structure/runtime state, not durable ontology."
    ),
    relatedOperationIds: []
  },
  {
    uriTemplate: "alaya://audit/trust-summaries/{summary_id}",
    name: "alaya.audit.trust_summary",
    description: "Session trust summary generated from audited session evidence.",
    classification: auditStatusClassification(
      "Trust summaries classify installed/configured/delivered/used evidence without becoming memory truth."
    ),
    relatedOperationIds: ["generate_trust_summary"]
  },
  {
    uriTemplate: "alaya://status/doctor",
    name: "alaya.status.doctor",
    description: "Runtime/package status report.",
    classification: auditStatusClassification(
      "Doctor status reports implementation readiness and migration state without claiming durable memory truth."
    ),
    relatedOperationIds: ["doctor"]
  }
] as const satisfies readonly McpResourceDescriptor[];

export const mcpPromptDescriptors = [
  {
    name: "alaya.recall.pre_turn",
    description: "Ask an agent to request Alaya recall context before acting.",
    capability: "recall_context",
    relatedOperationIds: ["assemble_recall_context"],
    strictness: getIntegrationOperationDescriptor("assemble_recall_context").strictness
  },
  {
    name: "alaya.proposal.post_turn",
    description: "Ask an agent to submit proposed memory candidates after a turn.",
    capability: "proposal_recording",
    relatedOperationIds: ["record_proposal"],
    strictness: getIntegrationOperationDescriptor("record_proposal").strictness
  },
  {
    name: "alaya.session.audit",
    description: "Ask an agent or adapter to record delivery and usage evidence separately.",
    capability: "session_audit",
    relatedOperationIds: ["record_memory_session_event", "generate_trust_summary"],
    strictness: getIntegrationOperationDescriptor("record_memory_session_event").strictness
  }
] as const satisfies readonly McpPromptDescriptor[];

export const alayaMcpSurfaceDescriptor = {
  name: "do-soul-alaya",
  protocol: "mcp-descriptor-no-sdk",
  runtimeBoundary: "injected_runtime_operation",
  tools: mcpToolDescriptors,
  resources: mcpResourceDescriptors,
  prompts: mcpPromptDescriptors
} as const satisfies AlayaMcpSurfaceDescriptor;

type McpToolDescriptorEntry = (typeof mcpToolDescriptors)[number];

export type McpToolName = McpToolDescriptorEntry["name"];
export type McpToolOperationId<T extends McpToolName> =
  Extract<McpToolDescriptorEntry, { readonly name: T }>["operationId"];
export type McpToolInput<T extends McpToolName> =
  IntegrationOperationInputMap[McpToolOperationId<T>];
export type McpToolResult<T extends McpToolName> =
  IntegrationOperationResultMap[McpToolOperationId<T>];

export interface McpToolInvocation<T extends McpToolName = McpToolName> {
  readonly name: T;
  readonly input: McpToolInput<T>;
  readonly metadata?: JsonObject;
}

export interface McpToolInvocationResult<T extends McpToolName = McpToolName> {
  readonly name: T;
  readonly operationId: McpToolOperationId<T>;
  readonly runtimeBoundary: "injected_runtime_operation";
  readonly capability: IntegrationCapability;
  readonly strictness: IntegrationStrictnessMetadata;
  readonly durableTruthProduced: false;
  readonly metadata?: JsonObject;
  readonly result: McpToolResult<T>;
}

export function listMcpToolDescriptors(): readonly McpToolDescriptor[] {
  return mcpToolDescriptors;
}

export function listMcpResourceDescriptors(): readonly McpResourceDescriptor[] {
  return mcpResourceDescriptors;
}

export function listMcpPromptDescriptors(): readonly McpPromptDescriptor[] {
  return mcpPromptDescriptors;
}

export function findMcpToolDescriptor(name: string): McpToolDescriptor | null {
  return mcpToolDescriptors.find((descriptor) => descriptor.name === name) ?? null;
}

export function findMcpResourceDescriptor(name: string): McpResourceDescriptor | null {
  return mcpResourceDescriptors.find((descriptor) => descriptor.name === name) ?? null;
}

export async function invokeMcpTool<T extends McpToolName>(
  runtime: AlayaIntegrationRuntimeBoundary,
  invocation: McpToolInvocation<T>
): Promise<McpToolInvocationResult<T>> {
  const descriptor = getMcpToolDescriptor(invocation.name) as Extract<
    McpToolDescriptorEntry,
    { readonly name: T }
  >;
  const result = await invokeIntegrationOperation(
    runtime,
    descriptor.operationId,
    invocation.input as unknown as IntegrationOperationInputMap[McpToolOperationId<T>]
  ) as McpToolResult<T>;

  const response = {
    name: invocation.name,
    operationId: descriptor.operationId as McpToolOperationId<T>,
    runtimeBoundary: "injected_runtime_operation",
    capability: descriptor.capability,
    strictness: descriptor.strictness,
    durableTruthProduced: descriptor.durableTruthProduced,
    result
  } satisfies Omit<McpToolInvocationResult<T>, "metadata">;

  if (invocation.metadata === undefined) {
    return response;
  }

  return {
    ...response,
    metadata: redactJsonObject(invocation.metadata)
  };
}

function getMcpToolDescriptor(name: McpToolName): McpToolDescriptorEntry {
  const descriptor = findMcpToolDescriptor(name);
  if (descriptor === null) {
    throw new AlayaValidationError(`Unsupported MCP tool: ${name}.`);
  }
  return descriptor as McpToolDescriptorEntry;
}

function createMcpToolDescriptor<N extends `alaya.${string}`, T extends IntegrationOperationId>(
  name: N,
  operationId: T,
  description: string
): McpToolDescriptor<T> & { readonly name: N } {
  const operation = getIntegrationOperationDescriptor(operationId);
  return {
    name,
    operationId,
    description,
    capability: operation.capability,
    strictness: operation.strictness,
    inputContract: operation.inputContract,
    resultContract: operation.resultContract,
    runtimeBoundary: "injected_runtime_operation",
    durableTruthProduced: operation.durableTruthProduced
  };
}

function runtimeProjectionClassification(description: string): McpResourceClassificationMetadata {
  return {
    kind: "runtime_projection",
    truthPlane: "runtime_control_plane",
    durableTruth: false,
    mayClaimDurableTruth: false,
    description
  };
}

function auditStatusClassification(description: string): McpResourceClassificationMetadata {
  return {
    kind: "audit_status",
    truthPlane: "session_audit_status",
    durableTruth: false,
    mayClaimDurableTruth: false,
    description
  };
}
