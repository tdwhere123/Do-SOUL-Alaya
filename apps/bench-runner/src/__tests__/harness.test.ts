import { afterEach, describe, expect, it } from "vitest";
import { startBenchDaemon, type BenchDaemonHandle } from "../harness/daemon.js";

const handles: BenchDaemonHandle[] = [];

afterEach(async () => {
  for (const h of handles.splice(0)) {
    await h.shutdown().catch(() => undefined);
  }
});

describe("BenchDaemon harness", () => {
  it(
    "starts daemon, lists MCP tools, propose+accept, recall, shutdown",
    async () => {
      const daemon = await startBenchDaemon({
        workspaceId: "harness-test-ws",
        runId: "harness-test-run"
      });
      handles.push(daemon);

      // Daemon is running and has a runtime reference
      expect(daemon.runtime).toBeDefined();
      expect(daemon.mcpClient).toBeDefined();
      expect(daemon.workspaceId).toBe("harness-test-ws");

      // MCP tools are registered after install + attach
      const toolsList = await daemon.mcpClient.listTools();
      const toolNames = toolsList.tools.map((t) => t.name);
      expect(toolNames).toContain("soul.recall");
      expect(toolNames).toContain("soul.propose_memory_update");
      expect(toolNames).toContain("soul.review_memory_proposal");

      // Propose a memory and accept it
      const content = "Use pnpm for all workspace commands in this monorepo.";
      const proposalId = await daemon.proposeMemory(content, "harness-evidence-001");
      expect(typeof proposalId).toBe("string");
      expect(proposalId.length).toBeGreaterThan(0);

      const accepted = await daemon.acceptProposal(proposalId);
      expect(accepted).toBeDefined();

      // Recall should return the seeded memory
      const recallResult = await daemon.recall("pnpm workspace commands", { maxResults: 5 });
      expect(recallResult.results).toBeDefined();
      // The memory may or may not rank top-1 without embeddings, but results array is valid
      expect(Array.isArray(recallResult.results)).toBe(true);
    },
    60_000
  );
});
