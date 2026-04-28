import type { ToolGovernanceDecision, ToolGovernanceQuery } from "./tool-governance.js";

/**
 * Cross-package port for querying the SOUL governance layer about tool permissions.
 * Defined in protocol so both core and soul can reference it without violating
 * the packages/core !-> packages/soul dependency constraint.
 *
 * Precedent: AgentRuntimePort in packages/protocol/src/runtime-port.ts.
 */
export interface ToolGovernancePort {
  readonly kind: string;
  queryToolGovernance(query: ToolGovernanceQuery): Promise<ToolGovernanceDecision>;
}
