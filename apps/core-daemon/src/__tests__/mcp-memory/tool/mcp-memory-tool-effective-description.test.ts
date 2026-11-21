import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { soulToolDefs } from "@do-soul/alaya-engine-gateway";
import { describe, expect, it } from "vitest";
import type { AlayaCliContext } from "../../../cli/bridge.js";
import { createToolsCommand } from "../../../cli/tools.js";
import {
  HOST_INTERPRETATION_AGENT_TARGET,
  HUMAN_REVIEW_ONLY_MEMORY_TOOL_NAMES
} from "../../../mcp-memory/proposal/reviewer-surfaces.js";
import { HOST_INTERPRETATION_ONLY_MEMORY_TOOL_NAMES } from "../../../mcp-memory/tool/attach-profile-tool-allowlist.js";
import {
  ALAYA_MEMORY_TOOL_NAMES,
  type AlayaMemoryToolName
} from "../../../mcp-memory/tool/tool-catalog.js";
import type { McpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";
import { createAlayaMcpServer } from "../../../mcp/server/mcp-server.js";
import {
  EXPECTED_LOOP_SUFFIX_BY_NAME,
  expectedEffectiveDescriptionByName
} from "./mcp-memory-tool-effective-description.fixture.js";

const unusedHandler: McpMemoryToolHandler = {
  call: async () => {
    throw new Error("effective-description list_tools test must not call tools");
  }
};

describe("MCP client-visible memory tool descriptions", () => {
  it("composes independent suffix text onto the SemVer-pinned gateway base", () => {
    expect(Object.keys(EXPECTED_LOOP_SUFFIX_BY_NAME)).toEqual([...ALAYA_MEMORY_TOOL_NAMES]);
    expect(soulToolDefs.map((spec) => spec.name)).toEqual([...ALAYA_MEMORY_TOOL_NAMES]);
    expect(EXPECTED_LOOP_SUFFIX_BY_NAME["soul.recall"]).not.toContain("information index");
    expect(soulToolDefs.find((spec) => spec.name === "soul.recall")?.description).not.toContain(
      "payload_continuation"
    );
    const expectedByName = expectedEffectiveDescriptionByName();
    expect(expectedByName.get("soul.recall")).toContain("information index");
    expect(expectedByName.get("soul.recall")).toContain("payload_continuation");
    for (const name of ["soul.interpretation", "garden.list_pending_tasks", "garden.claim_task", "garden.complete_task"] as const) {
      expect(EXPECTED_LOOP_SUFFIX_BY_NAME[name]).toBe("");
      expect(expectedByName.get(name)).toBe(soulToolDefs.find((spec) => spec.name === name)?.description);
    }
  });

  it("keeps attached-agent in-process list_tools descriptions identical for the visible subset", async () => {
    const expectedByName = expectedEffectiveDescriptionByName();
    const listed = await listToolsForAgentTarget("codex");
    const hidden = new Set<string>([
      ...HUMAN_REVIEW_ONLY_MEMORY_TOOL_NAMES,
      ...HOST_INTERPRETATION_ONLY_MEMORY_TOOL_NAMES
    ]);

    expect(listed.map((tool) => tool.name)).toEqual(
      ALAYA_MEMORY_TOOL_NAMES.filter((name) => !hidden.has(name))
    );
    expect(listed.map((tool) => tool.name)).not.toContain("soul.review_memory_proposal");
    expect(listed.map((tool) => tool.name)).not.toContain("soul.batch_review_edge_proposals");
    expect(listed.map((tool) => tool.name)).not.toContain("soul.interpretation");
    for (const published of listed) {
      expect(published.description).toBe(expectedByName.get(published.name as AlayaMemoryToolName));
    }

    const hostListed = await listToolsForAgentTarget(HOST_INTERPRETATION_AGENT_TARGET);
    expect(hostListed.find((tool) => tool.name === "soul.interpretation")?.description).toBe(
      expectedByName.get("soul.interpretation")
    );
    const inspectorListed = await listToolsForAgentTarget("inspector");
    expect(inspectorListed.find((tool) => tool.name === "soul.interpretation")?.description).toBe(
      expectedByName.get("soul.interpretation")
    );
  });

  it("lists an empty in-process catalog as no tools and still rejects unknown calls", async () => {
    const listed = await listToolsForAgentTarget("inspector", []);
    expect(listed).toEqual([]);

    const server = createAlayaMcpServer({
      memoryToolHandler: unusedHandler,
      contextProvider: () => ({
        workspaceId: "ws-effective-description",
        runId: null,
        agentTarget: "codex",
        sessionId: "effective-description-unknown"
      }),
      tools: []
    });
    const client = new Client({ name: "effective-description-unknown", version: "test" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      expect((await client.listTools()).tools).toEqual([]);
      const unknown = await client.callTool({ name: "soul.review_memory_proposal", arguments: {} });
      expect(unknown.isError).toBe(true);
      expect(unknown.structuredContent).toMatchObject({
        ok: false,
        error: { code: "UNKNOWN_TOOL" }
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("lists the same effective descriptions through the CLI tools handler", async () => {
    const expectedByName = expectedEffectiveDescriptionByName();
    const command = createToolsCommand({ handler: unusedHandler });
    const result = await command.handler(createCliContext(), {
      action: "list",
      toolName: null,
      input: {},
      contextOverrides: { workspaceId: null, runId: undefined, agentTarget: null }
    });

    expect(result.exitCode).toBe(0);
    const tools = (result.json as { readonly tools: readonly { readonly name: string; readonly description: string }[] })
      .tools;
    expect(tools.map((tool) => tool.name)).toEqual([...ALAYA_MEMORY_TOOL_NAMES]);
    for (const tool of tools) {
      expect(tool.description).toBe(expectedByName.get(tool.name as AlayaMemoryToolName));
    }
  });
});

async function listToolsForAgentTarget(
  agentTarget: string,
  tools: readonly [] | undefined = undefined
): Promise<readonly { readonly name: string; readonly description: string | undefined }[]> {
  const server = createAlayaMcpServer({
    memoryToolHandler: unusedHandler,
    contextProvider: () => ({
      workspaceId: "ws-effective-description",
      runId: null,
      agentTarget,
      sessionId: `effective-description-${agentTarget}`
    }),
    ...(tools === undefined ? {} : { tools })
  });
  const client = new Client({ name: "effective-description", version: "test" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    return listed.tools.map((tool) => ({ name: tool.name, description: tool.description }));
  } finally {
    await client.close();
    await server.close();
  }
}

function createCliContext(): AlayaCliContext {
  return {
    cwd: "/tmp",
    env: {},
    argv: [],
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    isTTY: false,
    daemon: { startupSteps: [] }
  };
}
