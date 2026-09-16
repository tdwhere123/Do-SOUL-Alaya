import { HUMAN_REVIEWER_AGENT_TARGETS } from "../mcp-memory/proposal/reviewer-surfaces.js";
import { DAEMON_ONLY_CONFIG_ENV_KEYS } from "../runtime/config/daemon-config-environment.js";
import { extractTomlBlock, isRecord, parseJsonObject } from "./profile-mutation/profile-mutation-text.js";
import type { ProfileTarget } from "./profile-mutation/profile-mutation-types.js";

export const MCP_TOOL_CONFIRMATION_TOKEN_ENV_KEY =
  DAEMON_ONLY_CONFIG_ENV_KEYS.mcp.toolConfirmationToken;

export function buildAttachedAgentMcpChildEnv(agentTarget: string): Readonly<Record<string, string>> {
  // Attach stamps identity only; HTTP and confirmation tokens stay off attached MCP child env.
  return Object.freeze({ ALAYA_AGENT_TARGET: agentTarget });
}

export function isAttachedAgentExecutorTarget(agentTarget: string | undefined): boolean {
  if (agentTarget === undefined || agentTarget.trim().length === 0) {
    return false;
  }
  return !HUMAN_REVIEWER_AGENT_TARGETS.has(agentTarget);
}

export function attachedAgentEnvHoldsConfirmationToken(
  env: Readonly<Record<string, string | undefined>>
): boolean {
  if (!isAttachedAgentExecutorTarget(env.ALAYA_AGENT_TARGET)) {
    return false;
  }
  const token = env[MCP_TOOL_CONFIRMATION_TOKEN_ENV_KEY]?.trim() ?? "";
  return token.length > 0;
}

export function stripReviewerCredentialsFromAgentMcpEnv(env: NodeJS.ProcessEnv): void {
  // Stdio is the executor; reviewer, HTTP, and confirmer secrets must not ride along.
  delete env.ALAYA_REVIEWER_TOKEN;
  delete env.ALAYA_REVIEWER_IDENTITY;
  delete env.ALAYA_REQUEST_TOKEN;
  delete env.ALAYA_REQUEST_TOKEN_WORKSPACES;
  delete env[MCP_TOOL_CONFIRMATION_TOKEN_ENV_KEY];
}

export function extractAttachedMcpEnvKeys(
  target: ProfileTarget,
  content: string | undefined
): readonly string[] {
  if (content === undefined || content.trim().length === 0) {
    return [];
  }
  if (target === "codex") {
    const block = extractTomlBlock(content, "[mcp_servers.alaya]");
    if (block === undefined) {
      return [];
    }
    const envBody = extractCodexMcpEnvTableBody(block);
    if (envBody === undefined) {
      return [];
    }
    return [...envBody.matchAll(/([A-Z][A-Z0-9_]*)\s*=/gu)].map((match) => match[1]!);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = parseJsonObject(content, ".claude.json");
  } catch {
    return [];
  }
  const alayaEntry = isRecord(parsed.mcpServers) ? parsed.mcpServers.alaya : undefined;
  const entryEnv = isRecord(alayaEntry) ? alayaEntry.env : undefined;
  if (!isRecord(entryEnv)) {
    return [];
  }
  return Object.keys(entryEnv);
}

function extractCodexMcpEnvTableBody(block: string): string | undefined {
  const envAssign = /\benv\s*=\s*\{/u.exec(block);
  if (envAssign === null) {
    return undefined;
  }
  return extractDoubleQuotedBalancedBraceBody(block, envAssign.index + envAssign[0].length - 1);
}

function extractDoubleQuotedBalancedBraceBody(
  source: string,
  openBraceIndex: number
): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = openBraceIndex; index < source.length; index += 1) {
    const char = source[index]!;
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char !== "}") {
      continue;
    }
    depth -= 1;
    if (depth === 0) {
      return source.slice(openBraceIndex + 1, index);
    }
  }
  return undefined;
}
