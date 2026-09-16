import { processEnvLookup } from "../../runtime/config/daemon-config-environment.js";
import { constantTimeTokenEqual } from "../../shared/constant-time-token.js";
import {
  attachedAgentEnvHoldsConfirmationToken,
  isAttachedAgentExecutorTarget,
  MCP_TOOL_CONFIRMATION_TOKEN_ENV_KEY
} from "../../attach/attached-agent-mcp-child-env.js";
import type { ToolUseBlock } from "@do-soul/alaya-protocol";

export type BuiltinToolConfirmationFailure = {
  readonly ok: false;
  readonly code: "CONFIRMATION_REQUIRED";
  readonly message: string;
};

export function authorizeConfirmedBuiltinTool(
  toolUse: ToolUseBlock,
  configuredToken: string | undefined
): { readonly ok: true; readonly input: Record<string, unknown> } | BuiltinToolConfirmationFailure {
  const env = processEnvLookup();
  if (attachedAgentEnvHoldsConfirmationToken(env)) {
    return {
      ok: false,
      code: "CONFIRMATION_REQUIRED",
      message:
        `Tool ${toolUse.name} cannot run in an attached-agent executor that holds ` +
        `${MCP_TOOL_CONFIRMATION_TOKEN_ENV_KEY}.`
    };
  }

  const envToken = isAttachedAgentExecutorTarget(env.ALAYA_AGENT_TARGET)
    ? undefined
    : env.ALAYA_MCP_TOOL_CONFIRMATION_TOKEN;
  const token = normalizeConfirmationToken(configuredToken ?? envToken);
  if (token === null) {
    return {
      ok: false,
      code: "CONFIRMATION_REQUIRED",
      message:
        `Tool ${toolUse.name} requires server-verifiable confirmation, but ` +
        `${MCP_TOOL_CONFIRMATION_TOKEN_ENV_KEY} is not configured.`
    };
  }

  const input = isRecord(toolUse.input) ? toolUse.input : {};
  const receipt = isRecord(input["_alaya_confirmation"]) ? input["_alaya_confirmation"] : null;
  const confirmed = receipt?.["confirmed"] === true;
  const providedToken = normalizeConfirmationToken(
    typeof receipt?.["token"] === "string" ? receipt["token"] : undefined
  );
  if (!confirmed || providedToken === null || !constantTimeTokenEqual(providedToken, token)) {
    return {
      ok: false,
      code: "CONFIRMATION_REQUIRED",
      message: `Tool ${toolUse.name} requires a valid server-verifiable confirmation receipt.`
    };
  }

  const { _alaya_confirmation: _confirmation, ...strippedInput } = input;
  void _confirmation;
  return { ok: true, input: strippedInput };
}

function normalizeConfirmationToken(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length === 0 ? null : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
