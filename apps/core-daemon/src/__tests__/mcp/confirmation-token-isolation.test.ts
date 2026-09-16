import { mkdir } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createAlayaCliBridge } from "../../cli/bridge.js";
import { createDoctorCommand } from "../../cli/doctor/doctor.js";
import {
  attachedAgentEnvHoldsConfirmationToken,
  buildAttachedAgentMcpChildEnv,
  extractAttachedMcpEnvKeys,
  isAttachedAgentExecutorTarget,
  MCP_TOOL_CONFIRMATION_TOKEN_ENV_KEY,
  stripReviewerCredentialsFromAgentMcpEnv
} from "../../attach/attached-agent-mcp-child-env.js";
import { handleConversationToolUse } from "../../mcp/tool-runtime/tool-runtime.js";
import {
  cleanupToolRuntimeTempDirs,
  createRuntimeContext,
  createWorkspace
} from "./tool-runtime-shared-fixture.js";

describe("confirmation token isolation", () => {
  const originalAgentTarget = process.env.ALAYA_AGENT_TARGET;
  const originalConfirmationToken = process.env.ALAYA_MCP_TOOL_CONFIRMATION_TOKEN;

  afterEach(async () => {
    restoreEnv("ALAYA_AGENT_TARGET", originalAgentTarget);
    restoreEnv("ALAYA_MCP_TOOL_CONFIRMATION_TOKEN", originalConfirmationToken);
    await cleanupToolRuntimeTempDirs();
  });

  it("does not stamp the confirmation token on attached MCP child env", () => {
    expect(buildAttachedAgentMcpChildEnv("codex")).toEqual({ ALAYA_AGENT_TARGET: "codex" });
    expect(buildAttachedAgentMcpChildEnv("codex")).not.toHaveProperty(MCP_TOOL_CONFIRMATION_TOKEN_ENV_KEY);
    expect(isAttachedAgentExecutorTarget("codex")).toBe(true);
    expect(isAttachedAgentExecutorTarget("cli")).toBe(false);
    expect(isAttachedAgentExecutorTarget(undefined)).toBe(false);
  });

  it("reads Codex MCP env keys after a nested inline table", () => {
    const content = [
      "[mcp_servers.alaya]",
      'command = "node"',
      'env = { extra = { FOO = "bar" }, ALAYA_AGENT_TARGET = "codex", ALAYA_MCP_TOOL_CONFIRMATION_TOKEN = "secret" }'
    ].join("\n");
    expect(extractAttachedMcpEnvKeys("codex", content)).toEqual([
      "FOO",
      "ALAYA_AGENT_TARGET",
      "ALAYA_MCP_TOOL_CONFIRMATION_TOKEN"
    ]);
  });

  it("strips the confirmation token from attached MCP stdio env", () => {
    const env: NodeJS.ProcessEnv = {
      ALAYA_AGENT_TARGET: "codex",
      ALAYA_MCP_TOOL_CONFIRMATION_TOKEN: "confirm-secret"
    };
    stripReviewerCredentialsFromAgentMcpEnv(env);
    expect(env.ALAYA_MCP_TOOL_CONFIRMATION_TOKEN).toBeUndefined();
    expect(env.ALAYA_AGENT_TARGET).toBe("codex");
    expect(
      attachedAgentEnvHoldsConfirmationToken({
        ALAYA_AGENT_TARGET: "codex",
        ALAYA_MCP_TOOL_CONFIRMATION_TOKEN: "confirm-secret"
      })
    ).toBe(true);
    expect(
      attachedAgentEnvHoldsConfirmationToken({
        ALAYA_MCP_TOOL_CONFIRMATION_TOKEN: "confirm-secret"
      })
    ).toBe(false);
  });

  it("rejects confirmation-required tools when the attached executor holds the token", async () => {
    process.env.ALAYA_AGENT_TARGET = "codex";
    process.env.ALAYA_MCP_TOOL_CONFIRMATION_TOKEN = "server-token";
    const workspaceDir = await createWorkspace();
    await mkdir(path.join(workspaceDir, "notes"), { recursive: true });

    const result = await handleConversationToolUse(
      {
        type: "tool_use",
        id: "toolu-executor-holds-token",
        name: "tools.write_file",
        input: {
          path: "notes/test.txt",
          content: "unsafe",
          _alaya_confirmation: {
            confirmed: true,
            token: "server-token"
          }
        }
      },
      createRuntimeContext(),
      {
        getById: async () => ({
          root_path: workspaceDir
        })
      },
      {
        execute: async () => {
          throw new Error("must not execute when the executor holds the confirmation token");
        }
      },
      {
        confirmationToken: "server-token"
      }
    );

    expect(result).toEqual({
      type: "tool_result",
      tool_use_id: "toolu-executor-holds-token",
      content: JSON.stringify({
        ok: false,
        code: "CONFIRMATION_REQUIRED",
        message:
          "Tool tools.write_file cannot run in an attached-agent executor that holds ALAYA_MCP_TOOL_CONFIRMATION_TOKEN."
      }),
      is_error: true
    });
  });

  it("marks doctor config failed when the attached executor env holds the confirmation token", async () => {
    const stdout = new PassThrough();
    const stdoutChunks: string[] = [];
    stdout.on("data", (chunk) => stdoutChunks.push(chunk.toString("utf8")));
    const bridge = createAlayaCliBridge(
      {
        startupSteps: (
          [
            "database",
            "repositories",
            "core-services",
            "garden-runtime",
            "mcp-tooling",
            "http-app"
          ] as const
        ).map((step) => ({ step, completedAt: "2026-05-05T00:00:00.000Z" }))
      },
      {
        env: {
          ALAYA_AGENT_TARGET: "codex",
          ALAYA_MCP_TOOL_CONFIRMATION_TOKEN: "confirm-secret"
        },
        stdout,
        stderr: new PassThrough(),
        isTTY: false
      }
    );
    bridge.registerSubcommand(
      createDoctorCommand({
        getToolchainStatus: async () => ({
          tools: {},
          active_worktrees: 1,
          db_path: "",
          files_dir: "/tmp/files"
        }),
        getMcpHealth: async () => ({ transport: "ready", enrolled_tools: 9 }),
        getGardenHealth: async () => ({
          status: "healthy",
          last_pass_at: "2026-05-05T00:00:00.000Z"
        }),
        clock: () => "2026-05-05T00:00:00.000Z"
      })
    );

    const jsonResult = await bridge.dispatch(["doctor", "--workspace", "workspace-1", "--json"]);
    const humanResult = await bridge.dispatch(["doctor", "--workspace", "workspace-1"]);
    expect(jsonResult.json).toMatchObject({
      confirmation_token_isolation: "executor_holds_token",
      checks: { config: "fail" }
    });
    expect(humanResult.exitCode).toBe(75);
    expect(stdoutChunks.join("")).toContain(
      "attached MCP executor holds ALAYA_MCP_TOOL_CONFIRMATION_TOKEN"
    );
  });
});

function restoreEnv(key: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = previous;
}
