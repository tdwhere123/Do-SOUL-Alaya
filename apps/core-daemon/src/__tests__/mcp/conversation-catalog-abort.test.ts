import { access } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDaemonConversationToolRuntimeCatalog } from "../../mcp/catalog/mcp-catalog-runtime.js";
import { executeConversationToolOrThrow } from "../../mcp/tool-runtime/tool-runtime.js";
import {
  cleanupToolRuntimeTempDirs,
  createRuntimeContext,
  createWorkspace,
  withToolConfirmation
} from "./tool-runtime-shared-fixture.js";

const HANDLER_TIMEOUT = {
  error_code: "handler_timeout",
  message: "MCP tool execution timed out.",
  error_type: "TimeoutError"
} as const;

afterEach(cleanupToolRuntimeTempDirs);

function createWriteCatalog() {
  return createDaemonConversationToolRuntimeCatalog({
    conversationToolCatalog: {
      hasToolName: (toolId) => toolId === "tools.write_file"
    },
    daemonMcpCatalog: {
      executeTool: async () => {
        throw new Error("external catalog execute must not run for builtin tools");
      }
    }
  });
}

describe("conversation catalog builtin abort", () => {
  it("does not write a file when executeConversationToolOrThrow sees abort", async () => {
    const workspaceDir = await createWorkspace();
    const target = path.join(workspaceDir, "notes.txt");
    const abort = new AbortController();
    abort.abort(HANDLER_TIMEOUT);

    await expect(
      executeConversationToolOrThrow(
        "tools.write_file",
        withToolConfirmation({
          path: "notes.txt",
          content: "secret"
        }),
        [workspaceDir],
        { abortSignal: abort.signal }
      )
    ).rejects.toEqual(HANDLER_TIMEOUT);
    await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not write a file when catalog builtin execute sees abort", async () => {
    const workspaceDir = await createWorkspace();
    const target = path.join(workspaceDir, "notes.txt");
    const abort = new AbortController();
    abort.abort(HANDLER_TIMEOUT);
    const catalog = createWriteCatalog();

    await expect(
      catalog.executeTool({
        toolId: "tools.write_file",
        rawInput: withToolConfirmation({
          path: "notes.txt",
          content: "secret"
        }),
        runtimeContext: createRuntimeContext(),
        writableRoots: [workspaceDir],
        abortSignal: abort.signal
      })
    ).rejects.toEqual(HANDLER_TIMEOUT);
    await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
