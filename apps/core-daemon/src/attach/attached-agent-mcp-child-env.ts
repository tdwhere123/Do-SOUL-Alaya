export function buildAttachedAgentMcpChildEnv(agentTarget: string): Readonly<Record<string, string>> {
  // Review credentials stay on human reviewer surfaces; attached MCP must not inherit them.
  return Object.freeze({ ALAYA_AGENT_TARGET: agentTarget });
}

export function stripReviewerCredentialsFromAgentMcpEnv(env: NodeJS.ProcessEnv): void {
  // Attached agents must not inherit reviewer credentials; review is human-surface only.
  delete env.ALAYA_REVIEWER_TOKEN;
  delete env.ALAYA_REVIEWER_IDENTITY;
}
