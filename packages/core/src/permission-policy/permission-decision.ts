import type { ToolPermissionResult } from "@do-soul/alaya-protocol";

export type PermissionDecisionReasonCode =
  | "read_only_tool"
  | "denied_tool_category"
  | "destructive_strict_posture"
  | "requires_confirmation"
  | "governance_deny"
  | "governance_ask"
  | "policy_allow";

export interface PermissionDecision {
  readonly result: ToolPermissionResult;
  readonly reasonCode: PermissionDecisionReasonCode;
  readonly explanation: string;
}
