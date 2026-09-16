export function buildAttachedAgentMcpChildEnv(agentTarget: string): Readonly<Record<string, string>> {
  // Attach profiles stamp identity only; HTTP tokens stay on the daemon HTTP listener.
  return Object.freeze({ ALAYA_AGENT_TARGET: agentTarget });
}

export function stripReviewerCredentialsFromAgentMcpEnv(env: NodeJS.ProcessEnv): void {
  // Stdio trust is the process; reviewer and HTTP tokens must not ride along.
  delete env.ALAYA_REVIEWER_TOKEN;
  delete env.ALAYA_REVIEWER_IDENTITY;
  delete env.ALAYA_REQUEST_TOKEN;
  delete env.ALAYA_REQUEST_TOKEN_WORKSPACES;
}
