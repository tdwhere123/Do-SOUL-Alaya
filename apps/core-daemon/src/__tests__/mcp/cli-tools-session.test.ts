import { PassThrough, Readable } from "node:stream";
import { expect, it, vi } from "vitest";
vi.hoisted(() => {
  for (const key of Object.keys(process.env)) if (/API_KEY|TOKEN|SECRET/u.test(key)) delete process.env[key];
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("provider transport forbidden"); }));
});
import { createToolsCommand } from "../../cli/tools.js";
import { createAlayaCliBridge } from "../../cli/bridge.js";
import type { McpMemoryToolHandler } from "../../mcp-memory/tool/tool-handler.js";

function session(stdin: Readable, handler: McpMemoryToolHandler) {
  const stdout = new PassThrough(), stderr = new PassThrough();
  const output: string[] = [];
  stdout.on("data", bytes => output.push(bytes.toString()));
  const bridge = createAlayaCliBridge({ startupSteps: [] }, { stdin, stdout, stderr, env: {} });
  bridge.registerSubcommand(createToolsCommand({ handler, defaultWorkspaceId: "workspace", defaultAgentTarget: "codex" }));
  return { output, run: () => bridge.dispatch(["tools", "session"]) };
}
const line = `${JSON.stringify({ tool: "soul.interpretation", arguments: {} })}\n`;
const success: Awaited<ReturnType<McpMemoryToolHandler["call"]>> = {
  ok: true, tool_name: "soul.interpretation", output: { operation: "reason",
    outcome: { status: "preparation_required", missing: "query_semantics_and_correspondence" },
    coverage: { discovery: "unexercised", source_interpretation: "unexercised", query_semantics: "unexercised",
      semantic_correspondence: "unexercised", conditional_computation: "unexercised", payload: "complete" },
    work: { native_work: 0, native_bytes: 0, logical_memory_bytes: 0, rss_bytes: 0 }, provider_attempts: 0 }
};

it("retains a principal per explicit CLI session while assigning independent sessions distinct principals", async () => {
  const contexts: { sessionId: string | undefined; workspaceId: string; agentTarget: string }[] = [];
  const handler: McpMemoryToolHandler = { call: async input => {
    contexts.push(input.context);
    return success;
  } };
  expect((await session(Readable.from([line + line]), handler).run()).exitCode).toBe(0);
  expect((await session(Readable.from([line]), handler).run()).exitCode).toBe(0);
  expect(contexts[0]?.sessionId).toBe(contexts[1]?.sessionId);
  expect(contexts[0]?.sessionId).not.toBe(contexts[2]?.sessionId);
  expect(contexts.every(row => row.workspaceId === "workspace" && row.agentTarget === "codex")).toBe(true);
});

it("rejects principal overrides and oversized JSON lines before the shared handler", async () => {
  const call = vi.fn<McpMemoryToolHandler["call"]>();
  for (const input of [JSON.stringify({ tool: "soul.interpretation", arguments: {}, sessionId: "foreign" }) + "\n",
    JSON.stringify({ tool: "soul.interpretation", arguments: "x".repeat(1_048_576) }) + "\n"]) {
    expect((await session(Readable.from([input]), { call }).run()).exitCode).toBe(65);
  }
  expect(call).not.toHaveBeenCalled();
});

it("ends bounded CLI admission after 256 calls without executing the next request", async () => {
  const call = vi.fn<McpMemoryToolHandler["call"]>(async () => success);
  expect((await session(Readable.from([line.repeat(257)]), { call }).run()).exitCode).toBe(65);
  expect(call).toHaveBeenCalledTimes(256);
});

it("aborts a pending CLI operation at session expiry and withholds a late success", async () => {
  vi.useFakeTimers();
  try {
    const stdin = new PassThrough();
    const call = vi.fn<McpMemoryToolHandler["call"]>(async input => {
      const signal = input.context.abortSignal!;
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      return success;
    });
    const boundary = session(stdin, { call });
    const running = boundary.run();
    stdin.write(line);
    await vi.advanceTimersByTimeAsync(300_001);
    expect((await running).exitCode).toBe(65);
    expect(call).toHaveBeenCalledOnce();
    expect(boundary.output).toEqual([]);
  } finally { vi.useRealTimers(); }
});
