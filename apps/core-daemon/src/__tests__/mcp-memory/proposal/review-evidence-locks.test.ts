import { describe, expect, it } from "vitest";
import { soulToolJsonSchemas } from "@do-soul/alaya-protocol";
import { ALAYA_MEMORY_TOOL_NAMES, listAlayaMemoryTools } from "../../../mcp-memory/tool/tool-catalog.js";

const expectedMemoryTools = [
  "soul.recall",
  "soul.open_pointer",
  "soul.emit_candidate_signal",
  "soul.propose_memory_update",
  "soul.review_memory_proposal",
  "soul.list_pending_proposals",
  "soul.propose_edge",
  "soul.list_pending_edge_proposals",
  "soul.batch_review_edge_proposals",
  "soul.apply_override",
  "soul.explore_graph",
  "soul.report_context_usage",
  "soul.resolve",
  "garden.list_pending_tasks",
  "garden.claim_task",
  "garden.complete_task"
] as const;

describe("MCP memory catalog", () => {
  it("keeps the public MCP memory tool catalog exact", () => {
    expect(ALAYA_MEMORY_TOOL_NAMES).toEqual(expectedMemoryTools);
    expect(ALAYA_MEMORY_TOOL_NAMES.some((name) => name.startsWith("memory."))).toBe(false);
  });

  it("publishes the named tools through the zod-derived catalog", () => {
    const definitions = listAlayaMemoryTools();
    expect(definitions.map((definition) => definition.name)).toEqual([...expectedMemoryTools]);
    for (const definition of definitions) {
      expect(soulToolJsonSchemas[definition.name]).toBe(definition.inputSchema);
      expect(isObjectInputSchema(definition.inputSchema)).toBe(true);
    }
  });
});

function isObjectInputSchema(schema: unknown): boolean {
  if (typeof schema !== "object" || schema === null) return false;
  const candidate = schema as { readonly type?: string; readonly anyOf?: readonly unknown[] };
  if (candidate.type === "object") return true;
  return candidate.anyOf?.every((branch) => isObjectInputSchema(branch)) === true;
}
