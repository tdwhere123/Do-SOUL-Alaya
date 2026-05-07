import { describe, expect, it } from "vitest";
import {
  ALAYA_MEMORY_TOOL_NAMES,
  hasAlayaMemoryToolName,
  listAlayaMemoryTools
} from "../mcp-memory-tool-catalog.js";
import { soulToolDefs } from "@do-soul/alaya-engine-gateway";

describe("mcp memory tool catalog", () => {
  it("exposes exactly the first-party soul tool names", () => {
    const tools = listAlayaMemoryTools();

    expect(tools.map((tool) => tool.name)).toEqual([...ALAYA_MEMORY_TOOL_NAMES]);
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length);
    expect(tools.map((tool) => tool.name).some((name) => name.startsWith("memory."))).toBe(false);
  });

  it("pins read-only annotations to read-only tools only", () => {
    const byName = new Map(listAlayaMemoryTools().map((tool) => [tool.name, tool] as const));

    expect(byName.get("soul.recall")?.annotations.readOnlyHint).toBe(true);
    expect(byName.get("soul.open_pointer")?.annotations.readOnlyHint).toBe(true);
    expect(byName.get("soul.explore_graph")?.annotations.readOnlyHint).toBe(true);
    expect(byName.get("garden.list_pending_tasks")?.annotations.readOnlyHint).toBe(true);
    expect(byName.get("garden.claim_task")?.annotations.readOnlyHint).toBe(false);
    expect(byName.get("garden.complete_task")?.annotations.idempotentHint).toBe(false);
    expect(byName.get("soul.report_context_usage")?.annotations.readOnlyHint).toBe(false);
  });

  it("guards supported tool names", () => {
    expect(hasAlayaMemoryToolName("soul.recall")).toBe(true);
    expect(hasAlayaMemoryToolName("memory.recall")).toBe(false);
  });

  it("stays aligned with provider-neutral model-visible specs without importing them at runtime", () => {
    const daemonCatalog = listAlayaMemoryTools();

    expect(daemonCatalog.map((tool) => tool.name)).toEqual(soulToolDefs.map((tool) => tool.name));
    expect(new Set(daemonCatalog.map((tool) => tool.name)).size).toBe(daemonCatalog.length);
    for (const tool of daemonCatalog) {
      const providerDescription = soulToolDefs.find((spec) => spec.name === tool.name)?.description;
      expect(providerDescription).toBeDefined();
      expect(
        tool.description === providerDescription ||
          tool.description.startsWith(`${providerDescription} `)
      ).toBe(true);
    }
    expect(daemonCatalog.find((tool) => tool.name === "soul.propose_memory_update")?.description).toContain(
      "pending proposal"
    );
    expect(daemonCatalog.find((tool) => tool.name === "soul.review_memory_proposal")?.description).toContain(
      "accept triggers apply"
    );
    expect(daemonCatalog.find((tool) => tool.name === "soul.list_pending_proposals")?.description).toContain(
      "not durable memory writes"
    );
    expect(daemonCatalog.find((tool) => tool.name === "garden.claim_task")?.description).toContain(
      "already_claimed"
    );
  });
});
