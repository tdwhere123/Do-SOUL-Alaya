import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createToolsCommand } from "../cli/tools.js";
import type { AlayaCliContext } from "../cli/bridge.js";
import { ALAYA_SYSEXITS } from "../cli/bridge.js";
import type { McpMemoryToolHandler } from "../mcp-memory-tool-handler.js";

describe("alaya tools", () => {
  it("lists the same first-party catalog used by MCP", async () => {
    const stdout = new PassThrough();
    const chunks: string[] = [];
    stdout.on("data", (chunk) => chunks.push(chunk.toString()));
    const command = createToolsCommand({ handler: createHandler() });

    const result = await command.handler(createContext({ stdout }), {
      action: "list",
      toolName: null,
      input: {},
      contextOverrides: { workspaceId: null, runId: undefined, agentTarget: null }
    });

    expect(result.exitCode).toBe(0);
    expect(chunks.join("")).toContain("soul.recall");
    expect(result.json).toMatchObject({
      tools: expect.arrayContaining([expect.objectContaining({ name: "soul.report_context_usage" })])
    });
  });

  it("calls the shared memory tool handler", async () => {
    const handler = createHandler();
    const stdout = new PassThrough();
    const chunks: string[] = [];
    stdout.on("data", (chunk) => chunks.push(chunk.toString()));
    const command = createToolsCommand({
      handler,
      defaultWorkspaceId: "ws1",
      defaultAgentTarget: "codex"
    });
    const parsed = command.argsSchema.safeParse([
      "call",
      "soul.open_pointer",
      "{\"object_id\":\"mem1\"}",
      "--run",
      "run1"
    ]);

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const result = await command.handler(createContext({ stdout }), parsed.data);

    expect(result.exitCode).toBe(0);
    expect(result.json).toEqual({ object_id: "mem1" });
    expect(chunks.join("")).toContain("\"mem1\"");
  });

  it("declares requiresDaemonReady === false so it can run without the daemon", () => {
    const command = createToolsCommand({ handler: createHandler() });
    expect(command.requiresDaemonReady).toBe(false);
  });

  it("maps VALIDATION handler errors to DATAERR (65) and writes the error code to stderr", async () => {
    const stderr = new PassThrough();
    const stderrChunks: string[] = [];
    stderr.on("data", (chunk) => stderrChunks.push(chunk.toString()));

    const validationHandler: McpMemoryToolHandler = {
      call: async ({ toolName }) => ({
        ok: false,
        tool_name: toolName,
        error: { code: "VALIDATION", message: "missing run_id" }
      })
    };
    const command = createToolsCommand({ handler: validationHandler });
    const parsed = command.argsSchema.safeParse([
      "call",
      "soul.emit_candidate_signal",
      "{}"
    ]);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const result = await command.handler(createContext({ stderr }), parsed.data);

    expect(result.exitCode).toBe(ALAYA_SYSEXITS.DATAERR);
    expect(result.exitCode).toBe(65);
    expect(stderrChunks.join("")).toContain("VALIDATION:");
    expect(stderrChunks.join("")).toContain("missing run_id");
    expect(result.json).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
  });

  it("maps UNKNOWN_TOOL handler errors to DATAERR (65)", async () => {
    const command = createToolsCommand({ handler: createHandler() });
    const parsed = command.argsSchema.safeParse([
      "call",
      "soul.does_not_exist",
      "{}"
    ]);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const result = await command.handler(createContext(), parsed.data);

    expect(result.exitCode).toBe(ALAYA_SYSEXITS.DATAERR);
    expect(result.json).toMatchObject({ ok: false, error: { code: "UNKNOWN_TOOL" } });
  });

  it("maps non-validation handler errors to SOFTWARE (70)", async () => {
    const stderr = new PassThrough();
    const stderrChunks: string[] = [];
    stderr.on("data", (chunk) => stderrChunks.push(chunk.toString()));

    const internalHandler: McpMemoryToolHandler = {
      call: async ({ toolName }) => ({
        ok: false,
        tool_name: toolName,
        error: { code: "INTERNAL", message: "transient db failure" }
      })
    };
    const command = createToolsCommand({ handler: internalHandler });
    const parsed = command.argsSchema.safeParse([
      "call",
      "soul.recall",
      "{\"query\":\"hello\"}"
    ]);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const result = await command.handler(createContext({ stderr }), parsed.data);

    expect(result.exitCode).toBe(ALAYA_SYSEXITS.SOFTWARE);
    expect(result.exitCode).toBe(70);
    expect(stderrChunks.join("")).toContain("INTERNAL:");
    expect(result.json).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
  });

  it("does not let generic tools call impersonate the human review CLI surface", async () => {
    const stderr = new PassThrough();
    const stderrChunks: string[] = [];
    stderr.on("data", (chunk) => stderrChunks.push(chunk.toString()));
    let handlerCalled = false;
    const command = createToolsCommand({
      handler: {
        call: async ({ toolName }) => {
          handlerCalled = true;
          return {
            ok: false,
            tool_name: toolName,
            error: { code: "VALIDATION", message: "should not reach handler" }
          };
        }
      }
    });
    const parsed = command.argsSchema.safeParse([
      "call",
      "soul.review_memory_proposal",
      "{\"proposal_id\":\"prop-1\",\"verdict\":\"accept\",\"reason\":null,\"reviewer_identity\":\"user:alice\"}",
      "--run",
      "null",
      "--agent",
      "cli"
    ]);

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const result = await command.handler(createContext({ stderr }), parsed.data);

    expect(result.exitCode).toBe(ALAYA_SYSEXITS.USAGE);
    expect(handlerCalled).toBe(false);
    expect(stderrChunks.join("")).toContain("use alaya review");
  });

  it("rejects malformed JSON arguments before reaching the handler", async () => {
    const command = createToolsCommand({ handler: createHandler() });
    const parsed = command.argsSchema.safeParse([
      "call",
      "soul.recall",
      "{not-valid-json"
    ]);

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0]?.message).toContain("malformed");
  });
});

function createHandler(): McpMemoryToolHandler {
  return {
    call: async ({ toolName }) => {
      if (toolName !== "soul.open_pointer") {
        return {
          ok: false,
          tool_name: toolName,
          error: { code: "UNKNOWN_TOOL", message: "unsupported" }
        };
      }

      return {
        ok: true,
        tool_name: "soul.open_pointer",
        output: { object_id: "mem1" }
      };
    }
  };
}

function createContext(overrides: Partial<AlayaCliContext> = {}): AlayaCliContext {
  return {
    cwd: "/tmp",
    env: {},
    argv: [],
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    isTTY: false,
    daemon: { startupSteps: [] },
    ...overrides
  };
}
