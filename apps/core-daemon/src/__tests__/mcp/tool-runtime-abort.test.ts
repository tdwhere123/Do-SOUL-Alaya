import { access } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { handleConversationToolUse } from "../../mcp/tool-runtime/tool-runtime.js";
import {
  cleanupToolRuntimeTempDirs,
  createAutoConfirmingBuiltinToolExecutor,
  createRuntimeContext,
  createWorkspace,
  TOOL_CONFIRMATION_TOKEN,
  withToolConfirmation
} from "./tool-runtime-shared-fixture.js";

const HANDLER_TIMEOUT = {
  error_code: "handler_timeout",
  message: "MCP tool execution timed out.",
  error_type: "TimeoutError"
} as const;

afterEach(cleanupToolRuntimeTempDirs);

describe("conversation tool abort plumbing", () => {
  it("passes abortSignal into conversation tool execution", async () => {
    const workspaceDir = await createWorkspace();
    const abort = new AbortController();
    let seen: AbortSignal | undefined;

    const result = await handleConversationToolUse(
      {
        type: "tool_use",
        id: "toolu-abort-signal",
        name: "mcp__filesystem__read_file",
        input: { path: "README.md" }
      },
      createRuntimeContext(),
      {
        getById: async () => ({
          root_path: workspaceDir
        })
      },
      {
        execute: async (request) => {
          seen = request.abortSignal;
          return { result: { ok: true } };
        }
      },
      {
        abortSignal: abort.signal,
        externalToolExecutor: {
          hasTool: (toolId: string) => toolId === "mcp__filesystem__read_file",
          executeTool: async () => ({ ok: true })
        }
      }
    );

    expect(result.is_error).toBeUndefined();
    expect(seen).toBe(abort.signal);
  });

  it("does not write a file when abort is already set before tools.write_file", async () => {
    const workspaceDir = await createWorkspace();
    const target = path.join(workspaceDir, "notes.txt");
    const abort = new AbortController();
    abort.abort(HANDLER_TIMEOUT);
    let executeAbort: AbortSignal | undefined;

    const result = await handleConversationToolUse(
      {
        type: "tool_use",
        id: "toolu-write-abort",
        name: "tools.write_file",
        input: withToolConfirmation({
          path: "notes.txt",
          content: "secret"
        })
      },
      createRuntimeContext(),
      {
        getById: async () => ({
          root_path: workspaceDir
        })
      },
      {
        execute: async (request) => ({
          result: await request.handler(
            { writableRoots: [request.workspaceRoot] },
            request.rawInput
          )
        })
      },
      {
        abortSignal: abort.signal,
        confirmationToken: TOOL_CONFIRMATION_TOKEN,
        externalToolExecutor: {
          hasTool: (toolId) => toolId === "tools.write_file",
          executeTool: async (input) => {
            executeAbort = input.abortSignal;
            return await createAutoConfirmingBuiltinToolExecutor(["tools.write_file"]).executeTool(input);
          }
        }
      }
    );

    expect(executeAbort).toBe(abort.signal);
    expect(result.is_error).toBe(true);
    await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
