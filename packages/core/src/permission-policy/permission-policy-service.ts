import type {
  StancePolicy,
  StanceResolution,
  ToolCategory,
  ToolGovernanceDecision,
  ToolSpec,
  WritePosture
} from "@do-soul/alaya-protocol";
import type { PermissionDecision, PermissionDecisionReasonCode } from "./permission-decision.js";

export interface PermissionResolutionInput {
  readonly toolSpec: Readonly<ToolSpec>;
  readonly governanceDecision: Readonly<ToolGovernanceDecision>;
  readonly stancePolicy: Readonly<StancePolicy> | undefined;
  readonly stanceResolution: Readonly<StanceResolution> | undefined;
  readonly deniedToolCategories: readonly ToolCategory[];
}

export function resolvePermission(input: PermissionResolutionInput): PermissionDecision {
  if (input.deniedToolCategories.includes(input.toolSpec.category)) {
    return buildDecision(
      "deny",
      "denied_tool_category",
      `Tool category "${input.toolSpec.category}" is denied for this worker.`
    );
  }

  if (input.governanceDecision.final_result === "deny") {
    return buildDecision(
      "deny",
      "governance_deny",
      `Governance denied this tool request: ${normalizeOneLine(input.governanceDecision.explanation_summary)}.`
    );
  }

  const writePosture = resolveWritePosture(input.stanceResolution, input.stancePolicy);
  if (input.toolSpec.destructive && writePosture === "strict") {
    return buildDecision(
      "deny",
      "destructive_strict_posture",
      "Destructive tools are denied while the effective write posture is strict."
    );
  }

  if (input.governanceDecision.final_result === "ask") {
    return buildDecision(
      "ask",
      "governance_ask",
      `Governance requires confirmation for this tool request: ${normalizeOneLine(input.governanceDecision.explanation_summary)}.`
    );
  }

  if (input.toolSpec.requires_confirmation) {
    return buildDecision(
      "ask",
      "requires_confirmation",
      "Tool execution requires explicit user confirmation before it can continue."
    );
  }

  if (input.toolSpec.read_only && input.toolSpec.fast_path_eligible) {
    return buildDecision(
      "allow",
      "read_only_tool",
      "Read-only fast-path-eligible tool is allowed when no higher-priority rule blocks it."
    );
  }

  return buildDecision(
    "allow",
    "policy_allow",
    "No higher-priority permission rule blocked this tool request."
  );
}

function resolveWritePosture(
  stanceResolution: Readonly<StanceResolution> | undefined,
  stancePolicy: Readonly<StancePolicy> | undefined
): WritePosture {
  return stanceResolution?.resolved_write_posture ?? stancePolicy?.default_write_posture ?? "permissive";
}

function buildDecision(
  result: PermissionDecision["result"],
  reasonCode: PermissionDecisionReasonCode,
  explanation: string
): PermissionDecision {
  return {
    result,
    reasonCode,
    explanation
  };
}

function normalizeOneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
