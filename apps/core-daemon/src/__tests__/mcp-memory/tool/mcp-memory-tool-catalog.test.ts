import { describe, expect, it } from "vitest";
import {
  ALAYA_MEMORY_TOOL_NAMES,
  hasAlayaMemoryToolName,
  listAlayaMemoryTools
} from "../../../mcp-memory/tool/tool-catalog.js";
import { soulToolJsonSchemas } from "@do-soul/alaya-protocol";
import { soulToolDefs } from "@do-soul/alaya-engine-gateway";

describe("mcp memory tool catalog", () => {
  it("pins read-only annotations to read-only tools only", () => {
    const byName = new Map(listAlayaMemoryTools().map((tool) => [tool.name, tool] as const));

    expect(byName.get("soul.recall")?.annotations.readOnlyHint).toBe(false);
    expect(byName.get("soul.recall")?.description).toContain("information index");
    expect(byName.get("soul.recall")?.description).toContain("`max_results` defaults to 10 and sets the page budget");
    expect(byName.get("soul.recall")?.description).toContain("`recent_turn` is ignored for extraction");
    expect(byName.get("soul.recall")?.description).not.toContain("POST_TURN_EXTRACT");
    expect(byName.get("soul.recall")?.description).not.toContain("ranked candidates");
    expect(byName.get("soul.open_pointer")?.annotations.readOnlyHint).toBe(true);
    expect(byName.get("soul.explore_graph")?.annotations.readOnlyHint).toBe(true);
    expect(byName.get("garden.list_pending_tasks")?.annotations.readOnlyHint).toBe(true);
    expect(byName.get("garden.claim_task")?.annotations.readOnlyHint).toBe(false);
    expect(byName.get("garden.complete_task")?.annotations.idempotentHint).toBe(false);
    expect(byName.get("soul.report_context_usage")?.annotations.readOnlyHint).toBe(false);
    expect(byName.get("soul.interpretation")?.annotations.readOnlyHint).toBe(false);
    expect(byName.get("soul.interpretation")?.annotations.destructiveHint).toBe(true);
    expect(byName.get("soul.interpretation")?.annotations.idempotentHint).toBe(true);
    expect(byName.get("soul.interpretation")?.description).toContain("host-owned interpretation operations");
    expect(byName.get("soul.interpretation")?.description).toContain(
      "may prepare an embedding through the configured runtime"
    );
    expect(byName.get("soul.interpretation")?.description).toContain(
      "language drafts and semantic generation occur outside this tool"
    );
    expect(byName.get("soul.interpretation")?.description).toContain(
      "local inference and external embedding attempts are reported separately"
    );
    expect(byName.get("soul.interpretation")?.description).not.toMatch(
      /provider-free|no operation calls a provider/iu
    );
    expect(byName.get("soul.interpretation")?.description).toContain(
      "soul.report_context_usage is not an interpretation delivery loop"
    );
    expect(byName.has("soul.recall")).toBe(true);
  });

  it("advertises minimal recall and how to open listed or ranked source results", () => {
    const tools = new Map(listAlayaMemoryTools().map(tool => [tool.name, tool]));
    const recallDescription = tools.get("soul.recall")?.description;
    expect(recallDescription).toContain('Start with soul.recall `{"query": "..."}`.');
    expect(recallDescription).toContain('"evidence_conditions": [{"statement":');
    expect(recallDescription).toContain('"evidence_relation": "derived"');
    const description = tools.get("soul.open_pointer")?.description;
    expect(description).toContain("`member_index[i].source_target` directly");
    expect(description).toContain("`source_target: { root_kind, root_id, source_version, content_digest, evidence_object_id }`");
    expect(description).toContain("`workspace_id`, `kind`, and `span`");
    expect(description).toContain("`target.span.content_end` as top-level `start_offset` instead of rereading from `0`");
    expect(description).toContain("do not reopen a ranked result whose `target.span.content_complete === true`");
    expect(description).toContain("Never put a source `root_id` in `object_id`");
  });

  it("guards supported tool names", () => {
    expect(hasAlayaMemoryToolName("soul.recall")).toBe(true);
    expect(hasAlayaMemoryToolName("memory.recall")).toBe(false);
  });

  it("generates descriptions from soulToolDefs and only appends a daemon loop suffix", () => {
    const daemonCatalog = listAlayaMemoryTools();

    expect(daemonCatalog.map((tool) => tool.name)).toEqual([...ALAYA_MEMORY_TOOL_NAMES]);
    expect(daemonCatalog.map((tool) => tool.name)).toEqual(soulToolDefs.map((tool) => tool.name));
    expect(new Set(daemonCatalog.map((tool) => tool.name)).size).toBe(daemonCatalog.length);
    expect(daemonCatalog.map((tool) => tool.name).some((name) => name.startsWith("memory."))).toBe(false);
    for (const tool of daemonCatalog) {
      const spec = soulToolDefs.find((candidate) => candidate.name === tool.name);
      expect(spec).toBeDefined();
      const providerDescription = spec?.description ?? "";
      expect(tool.description === providerDescription || tool.description.startsWith(`${providerDescription} `)).toBe(
        true
      );
    }
    const recall = daemonCatalog.find((tool) => tool.name === "soul.recall");
    const recallSpec = soulToolDefs.find((spec) => spec.name === "soul.recall");
    expect(recallSpec).toBeDefined();
    expect(recallSpec?.parametersSchema).toBeDefined();
    expect(recall?.inputSchema).toEqual(soulToolJsonSchemas["soul.recall"]);
    expect(recall?.description.startsWith(`${recallSpec?.description} `)).toBe(true);
    expect(daemonCatalog.find((tool) => tool.name === "soul.propose_memory_update")?.description).toContain(
      "pending proposal"
    );
    expect(daemonCatalog.find((tool) => tool.name === "soul.review_memory_proposal")?.description).toContain(
      "accept triggers apply"
    );
    expect(daemonCatalog.find((tool) => tool.name === "soul.list_pending_proposals")?.description).toContain(
      "not durable memory writes"
    );
    expect(daemonCatalog.find((tool) => tool.name === "soul.emit_candidate_signal")?.description).toContain(
      "source_memory_refs"
    );
    expect(daemonCatalog.find((tool) => tool.name === "soul.emit_candidate_signal")?.description).toContain(
      "not put those graph hints only in raw_payload"
    );
    expect(daemonCatalog.find((tool) => tool.name === "garden.claim_task")?.description).toContain(
      "already_claimed"
    );
    expect(recallSpec?.description).toContain("information index");
    expect(recallSpec?.description).toContain("`recent_turn` is ignored for extraction");
    expect(recallSpec?.description).not.toContain("ranked candidates");
  });
});
