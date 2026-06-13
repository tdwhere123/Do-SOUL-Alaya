import type { ToolGovernanceDecision, ToolGovernanceQuery } from "./tool-governance.js";

/**
 * Protocol-owned port so core and soul can query tool governance without reversing dependencies.
 */
export interface ToolGovernancePort {
  readonly kind: string;
  queryToolGovernance(query: ToolGovernanceQuery): Promise<ToolGovernanceDecision>;
}
