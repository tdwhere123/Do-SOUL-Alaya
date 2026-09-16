import { afterEach, describe, expect, it, vi } from "vitest";

const HANDLER_TIMEOUT = {
  error_code: "handler_timeout",
  message: "MCP tool execution timed out.",
  error_type: "TimeoutError"
} as const;

const hoisted = vi.hoisted(() => ({
  executeConversationToolOrThrow: vi.fn()
}));

vi.mock("../../mcp/tool-runtime/tool-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../mcp/tool-runtime/tool-runtime.js")>();
  return {
    ...actual,
    executeConversationToolOrThrow: (...args: unknown[]) =>
      hoisted.executeConversationToolOrThrow(...args)
  };
});

import { createDaemonConversationToolRuntimeCatalog } from "../../mcp/catalog/mcp-catalog-runtime.js";
import { createRuntimeContext } from "./tool-runtime-shared-fixture.js";

afterEach(() => {
  vi.unstubAllEnvs();
  hoisted.executeConversationToolOrThrow.mockReset();
});

describe("catalog builtin MCP timeout", () => {
  it("threads a timeout abort signal into tools.write_file when catalog execute omits one", async () => {
    vi.stubEnv("ALAYA_MCP_TOOL_TIMEOUT_MS", "20");
    hoisted.executeConversationToolOrThrow.mockImplementation(
      async (
        _toolId: string,
        _rawInput: unknown,
        _writableRoots: readonly string[],
        options: { readonly abortSignal?: AbortSignal } = {}
      ) => {
        const signal = options.abortSignal;
        if (signal === undefined) {
          throw new Error("catalog builtin execute did not thread an abort signal");
        }
        if (signal.aborted) {
          throw signal.reason ?? HANDLER_TIMEOUT;
        }
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        throw signal.reason ?? HANDLER_TIMEOUT;
      }
    );

    const catalog = createDaemonConversationToolRuntimeCatalog({
      conversationToolCatalog: {
        hasToolName: (toolId) => toolId === "tools.write_file"
      },
      daemonMcpCatalog: {
        executeTool: async () => {
          throw new Error("external catalog execute must not run for builtin tools");
        }
      }
    });

    await expect(
      catalog.executeTool({
        toolId: "tools.write_file",
        rawInput: { path: "notes.txt", content: "secret" },
        runtimeContext: createRuntimeContext(),
        writableRoots: ["/tmp"],
      })
    ).rejects.toEqual(HANDLER_TIMEOUT);
    expect(hoisted.executeConversationToolOrThrow).toHaveBeenCalledTimes(1);
    expect(hoisted.executeConversationToolOrThrow.mock.calls[0]?.[3]).toEqual(
      expect.objectContaining({
        abortSignal: expect.any(AbortSignal)
      })
    );
  });
});
