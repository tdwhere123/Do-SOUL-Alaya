import { PassThrough } from "node:stream";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { createToolsCommand } from "../../cli/tools.js";
import type { AlayaCliContext } from "../../cli/bridge.js";
import { ALAYA_SYSEXITS } from "../../cli/bridge.js";
import { createMcpMemoryToolHandler } from "../../mcp-memory/tool-handler.js";
import type { McpMemoryToolHandler } from "../../mcp-memory/tool-handler.js";
import { callAlayaMcpMemoryTool } from "../../mcp/mcp-server.js";
import {
  context as realHandlerContext,
  createDeps
} from "../mcp-memory/mcp-memory-tool-handler-fixture.js";
import { fixturePath } from "../support/test-paths.js";

// Parity runs through one real handler (createMcpMemoryToolHandler over the
// in-memory fixture) so CLI arg-marshalling drift vs the MCP request shape fails
// here, not just wiring.
describe("alaya tools real-handler CLI/MCP parity", () => {
  async function callViaMcp(toolName: string, args: unknown): Promise<unknown> {
    const mcpResult = await callAlayaMcpMemoryTool(
      {
        memoryToolHandler: createMcpMemoryToolHandler(createDeps()),
        contextProvider: () => realHandlerContext
      },
      toolName,
      args
    );
    return (mcpResult.structuredContent as { readonly output: unknown }).output;
  }

  async function callViaCli(toolName: string, args: unknown): Promise<unknown> {
    const command = createToolsCommand({
      handler: createMcpMemoryToolHandler(createDeps()),
      defaultWorkspaceId: realHandlerContext.workspaceId,
      defaultRunId: realHandlerContext.runId,
      defaultAgentTarget: realHandlerContext.agentTarget,
      runService: createRunLookup({ run1: realHandlerContext.workspaceId })
    });
    const parsed = command.argsSchema.safeParse(["call", toolName, JSON.stringify(args)]);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("CLI args parse failed in test setup");
    const result = await command.handler(createContext(), parsed.data);
    expect(result.exitCode).toBe(ALAYA_SYSEXITS.OK);
    return result.json;
  }

  it("returns the same soul.recall output through MCP and CLI", async () => {
    const args = {
      query: "deployment rules",
      scope_class: null,
      dimension: null,
      domain_tags: null,
      max_results: 3
    };
    const [mcpOutput, cliOutput] = await Promise.all([
      callViaMcp("soul.recall", args),
      callViaCli("soul.recall", args)
    ]);
    expect(cliOutput).toEqual(mcpOutput);
  });

  it("returns the same soul.open_pointer output through MCP and CLI", async () => {
    // createDeps().memoryService.findByIdScoped seeds an in-memory entry for
    // mem1, so the pointer dereferences instead of NOT_FOUND.
    const args = { object_id: "mem1" };
    const [mcpOutput, cliOutput] = await Promise.all([
      callViaMcp("soul.open_pointer", args),
      callViaCli("soul.open_pointer", args)
    ]);
    expect(mcpOutput).toMatchObject({ object_id: "mem1", object_kind: "memory_entry" });
    expect(cliOutput).toEqual(mcpOutput);
  });

  it("returns the same soul.emit_candidate_signal output through MCP and CLI", async () => {
    const args = {
      signal_kind: "potential_preference",
      object_kind: "preference",
      scope_hint: null,
      domain_tags: [],
      confidence: 0.9,
      evidence_refs: [],
      raw_payload: { content: "prefers dark mode" }
    };
    const [mcpOutput, cliOutput] = await Promise.all([
      callViaMcp("soul.emit_candidate_signal", args),
      callViaCli("soul.emit_candidate_signal", args)
    ]);
    expect(mcpOutput).toMatchObject({ status: "emitted" });
    expect(cliOutput).toEqual(mcpOutput);
  });
});

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
      defaultAgentTarget: "codex",
      runService: createRunLookup({ run1: "ws1" })
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

  it("defaults tools calls to a registered cwd-derived local workspace", async () => {
    const projectRoot = path.resolve(fixturePath("alaya-project"));
    let observedWorkspaceId: string | null = null;
    const ensureLocalWorkspace = vi.fn(async () => undefined);
    const command = createToolsCommand({
      handler: {
        call: async ({ context, toolName }) => {
          observedWorkspaceId = context.workspaceId;
          return {
            ok: true,
            tool_name: toolName,
            output: { workspace_id: context.workspaceId }
          };
        }
      } as McpMemoryToolHandler,
      ensureLocalWorkspace: { ensureLocalWorkspace }
    });
    const parsed = command.argsSchema.safeParse([
      "call",
      "soul.recall",
      "{\"query\":\"hello\"}"
    ]);

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const result = await command.handler(createContext({ cwd: projectRoot }), parsed.data);

    expect(result.exitCode).toBe(0);
    expect(observedWorkspaceId).toMatch(/^local_[a-f0-9]{16}$/);
    expect(ensureLocalWorkspace).toHaveBeenCalledWith({
      workspaceId: observedWorkspaceId,
      name: "alaya-project",
      rootPath: projectRoot
    });
  });

  it("does not register cwd when an explicit workspace override is provided", async () => {
    const ensureLocalWorkspace = vi.fn(async () => undefined);
    const command = createToolsCommand({
      handler: createHandler(),
      ensureLocalWorkspace: { ensureLocalWorkspace }
    });
    const parsed = command.argsSchema.safeParse([
      "call",
      "soul.open_pointer",
      "{\"object_id\":\"mem1\"}",
      "--workspace",
      "workspace-explicit"
    ]);

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const result = await command.handler(
      createContext({ cwd: path.resolve(fixturePath("alaya-project")) }),
      parsed.data
    );

    expect(result.exitCode).toBe(0);
    expect(ensureLocalWorkspace).not.toHaveBeenCalled();
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

  it("rejects a foreign ALAYA_RUN_ID before stateful tools reach the handler", async () => {
    const stderr = new PassThrough();
    const stderrChunks: string[] = [];
    stderr.on("data", (chunk) => stderrChunks.push(chunk.toString()));
    const handler = { call: vi.fn(async () => ({
      ok: true,
      tool_name: "soul.emit_candidate_signal",
      output: { signal_id: "sig-1" }
    } as const)) };
    const command = createToolsCommand({
      handler,
      defaultWorkspaceId: "workspace-1",
      runService: createRunLookup({ "run-foreign": "workspace-2" })
    });
    const parsed = command.argsSchema.safeParse([
      "call",
      "soul.emit_candidate_signal",
      "{}"
    ]);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const result = await command.handler(
      createContext({ stderr, env: { ALAYA_RUN_ID: "run-foreign" } }),
      parsed.data
    );

    expect(result.exitCode).toBe(ALAYA_SYSEXITS.DATAERR);
    expect(stderrChunks.join("")).toContain(
      "ALAYA_RUN_ID run-foreign belongs to workspace workspace-2, not workspace-1."
    );
    expect(handler.call).not.toHaveBeenCalled();
  });

  it("rejects a foreign --run override before stateful tools reach the handler", async () => {
    const stderr = new PassThrough();
    const stderrChunks: string[] = [];
    stderr.on("data", (chunk) => stderrChunks.push(chunk.toString()));
    const handler = { call: vi.fn(async () => ({
      ok: true,
      tool_name: "soul.apply_override",
      output: { override_id: "override-1" }
    } as const)) };
    const command = createToolsCommand({
      handler,
      defaultWorkspaceId: "workspace-1",
      runService: createRunLookup({ "run-foreign": "workspace-2" })
    });
    const parsed = command.argsSchema.safeParse([
      "call",
      "soul.apply_override",
      "{}",
      "--run",
      "run-foreign"
    ]);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const result = await command.handler(createContext({ stderr }), parsed.data);

    expect(result.exitCode).toBe(ALAYA_SYSEXITS.DATAERR);
    expect(stderrChunks.join("")).toContain(
      "--run run-foreign belongs to workspace workspace-2, not workspace-1."
    );
    expect(handler.call).not.toHaveBeenCalled();
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

  it("does not let generic tools call impersonate the edge review CLI surface", async () => {
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
      "soul.batch_review_edge_proposals",
      "{\"verdict\":\"accept\",\"filter\":{\"proposal_ids\":[\"edge-proposal-1\"]},\"reason\":null,\"reviewer_identity\":\"user:alice\"}",
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

function createRunLookup(workspaceByRun: Record<string, string>) {
  return {
    getById: vi.fn(async (runId: string) => ({
      workspace_id: workspaceByRun[runId] ?? "workspace-missing"
    }))
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
