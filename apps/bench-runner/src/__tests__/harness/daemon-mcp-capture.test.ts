import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { callMcpTool, type BenchMcpToolCapture } from "../../harness/daemon/runtime/daemon-mcp-support.js";

async function withEchoTool(work: (client: Client) => Promise<void>, fail = false): Promise<void> {
  const server = new McpServer({ name: "capture-fixture", version: "1.0.0" });
  const client = new Client({ name: "capture-consumer", version: "1.0.0" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  server.registerTool("echo", { inputSchema: { text: z.string() } }, async ({ text }) => {
    if (fail) return { isError: true, content: [{ type: "text", text: "native refusal" }] };
    const output = { nested: { text } };
    return { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: { ok: true, output } };
  });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await work(client);
  } finally {
    await client.close();
    await server.close();
  }
}

describe("bench MCP envelope capture", () => {
  it("retains emitted text while isolating capture mutations from caller and admitted output", async () => {
    await withEchoTool(async client => {
      const args = { text: "original" };
      let archived: BenchMcpToolCapture | undefined;
      const pending = callMcpTool(client, "echo", args, frame => {
        archived = structuredClone(frame);
        frame.request.arguments.text = "observer mutation";
        const response = frame.response as { structuredContent: { output: { nested: { text: string } } } };
        response.structuredContent.output.nested.text = "observer mutation";
      });
      args.text = "caller mutation";
      expect(await pending).toEqual({ nested: { text: "original" } });
      expect(args.text).toBe("caller mutation");
      expect(archived).toMatchObject({ request: { name: "echo", arguments: { text: "original" } },
        response: { content: [{ type: "text", text: '{"nested":{"text":"original"}}' }] } });
    });
  });

  it("captures a native refusal before the existing call owner rejects it", async () => {
    await withEchoTool(async client => {
      const frames: BenchMcpToolCapture[] = [];
      await expect(callMcpTool(client, "echo", { text: "ignored" }, frame => { frames.push(frame); }))
        .rejects.toThrow("MCP tool echo failed: native refusal");
      expect(frames).toHaveLength(1);
      expect(frames[0]!.response).toMatchObject({ isError: true,
        content: [{ type: "text", text: "native refusal" }] });
    }, true);
  });
});
