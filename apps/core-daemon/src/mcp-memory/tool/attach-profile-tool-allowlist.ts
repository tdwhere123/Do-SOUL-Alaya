import {
  HOST_INTERPRETATION_CATALOG_AGENT_TARGETS,
  HUMAN_REVIEWER_AGENT_TARGETS,
  HUMAN_REVIEW_ONLY_MEMORY_TOOL_NAMES
} from "../proposal/reviewer-surfaces.js";
import {
  listAlayaMemoryTools,
  type AlayaMemoryToolDefinition,
  type AlayaMemoryToolName
} from "./tool-catalog.js";

export type McpToolCatalogProfile = "consumer" | "host";

export const HOST_INTERPRETATION_ONLY_MEMORY_TOOL_NAMES = Object.freeze([
  "soul.interpretation"
] as const);

export function isHumanReviewerAgentTarget(agentTarget: string): boolean {
  return HUMAN_REVIEWER_AGENT_TARGETS.has(agentTarget);
}

export function isHumanReviewOnlyMemoryTool(toolName: string): boolean {
  return (HUMAN_REVIEW_ONLY_MEMORY_TOOL_NAMES as readonly string[]).includes(toolName);
}

export function isHostInterpretationOnlyMemoryTool(toolName: string): boolean {
  return (HOST_INTERPRETATION_ONLY_MEMORY_TOOL_NAMES as readonly string[]).includes(toolName);
}

export function resolveToolCatalogProfileForAgentTarget(
  agentTarget: string,
  profile?: McpToolCatalogProfile
): McpToolCatalogProfile {
  return profile ?? (HOST_INTERPRETATION_CATALOG_AGENT_TARGETS.has(agentTarget) ? "host" : "consumer");
}

export function isMemoryToolAllowedForAgentTarget(toolName: string, agentTarget: string): boolean {
  if (HUMAN_REVIEWER_AGENT_TARGETS.has(agentTarget)) {
    return true;
  }
  return !isHumanReviewOnlyMemoryTool(toolName);
}

export function listAlayaMemoryToolsForAgentTarget(
  agentTarget: string,
  catalog: readonly AlayaMemoryToolDefinition[] = listAlayaMemoryTools(),
  profile?: McpToolCatalogProfile
): readonly AlayaMemoryToolDefinition[] {
  const allowHumanReviewTools = HUMAN_REVIEWER_AGENT_TARGETS.has(agentTarget);
  const includeHostInterpretation = resolveToolCatalogProfileForAgentTarget(agentTarget, profile) === "host";
  if (allowHumanReviewTools && includeHostInterpretation) {
    return catalog;
  }
  return catalog.filter((tool) =>
    (allowHumanReviewTools || !isHumanReviewOnlyMemoryTool(tool.name)) &&
    (includeHostInterpretation || !isHostInterpretationOnlyMemoryTool(tool.name))
  );
}

export const ATTACHED_AGENT_MEMORY_TOOL_NAMES: readonly AlayaMemoryToolName[] = Object.freeze(
  listAlayaMemoryToolsForAgentTarget("codex").map((tool) => tool.name)
);
