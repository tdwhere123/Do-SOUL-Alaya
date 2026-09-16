import { afterEach, describe, expect, it } from "vitest";
import { handleConversationToolUse } from "../../mcp/tool-runtime/tool-runtime.js";
import {
  cleanupToolRuntimeTempDirs,
  createRuntimeContext,
  createWorkspace
} from "./tool-runtime-shared-fixture.js";

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
});
