import {
  HUMAN_REVIEWER_AGENT_TARGETS,
  HUMAN_REVIEW_ONLY_MEMORY_TOOL_NAMES
} from "../proposal/reviewer-surfaces.js";
import {
  listAlayaMemoryTools,
  type AlayaMemoryToolDefinition,
  type AlayaMemoryToolName
} from "./tool-catalog.js";

export function isHumanReviewerAgentTarget(agentTarget: string): boolean {
  return HUMAN_REVIEWER_AGENT_TARGETS.has(agentTarget);
}

export function isHumanReviewOnlyMemoryTool(toolName: string): boolean {
  return (HUMAN_REVIEW_ONLY_MEMORY_TOOL_NAMES as readonly string[]).includes(toolName);
}

export function isMemoryToolAllowedForAgentTarget(toolName: string, agentTarget: string): boolean {
  if (HUMAN_REVIEWER_AGENT_TARGETS.has(agentTarget)) {
    return true;
  }
  return !isHumanReviewOnlyMemoryTool(toolName);
}

export function listAlayaMemoryToolsForAgentTarget(
  agentTarget: string,
  catalog: readonly AlayaMemoryToolDefinition[] = listAlayaMemoryTools()
): readonly AlayaMemoryToolDefinition[] {
  if (HUMAN_REVIEWER_AGENT_TARGETS.has(agentTarget)) {
    return catalog;
  }
  return catalog.filter((tool) => !isHumanReviewOnlyMemoryTool(tool.name));
}

export const ATTACHED_AGENT_MEMORY_TOOL_NAMES: readonly AlayaMemoryToolName[] = Object.freeze(
  listAlayaMemoryTools()
    .map((tool) => tool.name)
    .filter((name) => !isHumanReviewOnlyMemoryTool(name))
);
