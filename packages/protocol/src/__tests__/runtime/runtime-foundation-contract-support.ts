type ParseableSchema = {
  readonly parse: (value: unknown) => unknown;
  readonly safeParse: (value: unknown) => { readonly success: boolean };
};

export const validTimestamp = "2026-04-10T00:00:00.000Z";
export const laterTimestamp = "2026-04-10T01:00:00.000Z";

export const requiredRuntimeFoundationExports = [
  "ToolSpecSchema",
  "ToolGovernanceQuerySchema",
  "ToolGovernanceDecisionSchema",
  "ToolExecutionRecordSchema",
  "PrincipalRunSchema",
  "DelegatedWorkerRunSchema",
  "StancePolicySchema",
  "StanceResolutionSchema",
  "NarrativeDigestSchema",
  "ConsolidationTriggerBudgetSchema",
  "EngineClassSchema",
  "ClaimModeSchema",
  "WorkerRunStateSchema",
  "RuntimeSessionSchema",
  "RuntimeTurnInputSchema",
  "RuntimeCapabilitiesSchema",
  "RuntimeSessionConfigSchema",
  "RuntimeSandboxPolicySchema",
  "RuntimePermissionPolicySchema",
  "RuntimeNetworkPolicySchema",
  "RuntimeCancelResultSchema",
  "RuntimeEventSchema",
  "OrphanedMemoryRecordSchema",
  "NodeTemplateKindSchema",
  "FrozenNodeTemplateContractsSchema",
  "FROZEN_NODE_TEMPLATE_CONTRACTS",
  "FrozenNodeTemplateContracts",
  "assertFrozenNodeTemplateContracts"
] as const;

export async function loadRuntimeFoundationContracts() {
  const protocol = (await import("../../" + "index.js")) as Record<string, unknown>;
  return {
    protocol,
    ToolSpecSchema: protocol.ToolSpecSchema as ParseableSchema,
    ToolGovernanceQuerySchema: protocol.ToolGovernanceQuerySchema as ParseableSchema,
    ToolGovernanceDecisionSchema: protocol.ToolGovernanceDecisionSchema as ParseableSchema,
    ToolExecutionRecordSchema: protocol.ToolExecutionRecordSchema as ParseableSchema,
    PrincipalRunSchema: protocol.PrincipalRunSchema as ParseableSchema,
    DelegatedWorkerRunSchema: protocol.DelegatedWorkerRunSchema as ParseableSchema,
    StancePolicySchema: protocol.StancePolicySchema as ParseableSchema,
    StanceResolutionSchema: protocol.StanceResolutionSchema as ParseableSchema,
    NarrativeDigestSchema: protocol.NarrativeDigestSchema as ParseableSchema,
    ConsolidationTriggerBudgetSchema: protocol.ConsolidationTriggerBudgetSchema as ParseableSchema,
    RuntimeSessionSchema: protocol.RuntimeSessionSchema as ParseableSchema,
    RuntimeTurnInputSchema: protocol.RuntimeTurnInputSchema as ParseableSchema,
    RuntimeCapabilitiesSchema: protocol.RuntimeCapabilitiesSchema as ParseableSchema,
    RuntimeSessionConfigSchema: protocol.RuntimeSessionConfigSchema as ParseableSchema,
    RuntimeSandboxPolicySchema: protocol.RuntimeSandboxPolicySchema as ParseableSchema,
    RuntimePermissionPolicySchema: protocol.RuntimePermissionPolicySchema as ParseableSchema,
    RuntimeNetworkPolicySchema: protocol.RuntimeNetworkPolicySchema as ParseableSchema,
    RuntimeCancelResultSchema: protocol.RuntimeCancelResultSchema as ParseableSchema,
    RuntimeEventSchema: protocol.RuntimeEventSchema as ParseableSchema,
    OrphanedMemoryRecordSchema: protocol.OrphanedMemoryRecordSchema as ParseableSchema,
    NodeTemplateKindSchema: protocol.NodeTemplateKindSchema as { options: readonly string[] },
    FrozenNodeTemplateContractsSchema: protocol.FrozenNodeTemplateContractsSchema as ParseableSchema,
    FROZEN_NODE_TEMPLATE_CONTRACTS: protocol.FROZEN_NODE_TEMPLATE_CONTRACTS as readonly unknown[],
    FrozenNodeTemplateContracts: protocol.FrozenNodeTemplateContracts as readonly unknown[],
    assertFrozenNodeTemplateContracts: protocol.assertFrozenNodeTemplateContracts as (value?: unknown) => void
  };
}
