import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveAddressableSpanViews } from "@do-soul/alaya-core";
import { SoulMemorySearchRequestSchema, type SoulMemorySearchResponse } from "@do-soul/alaya-protocol";
import { startBenchDaemon } from "../../../harness/daemon.js";
import { callMcpTool } from "../../../harness/daemon/runtime/daemon-mcp-support.js";

const NOW = "2026-09-13T00:00:00.000Z";
const EVENT = "2026-09-12T12:00:00.000Z";

describe("workspace-bound source admission through the native Recall worker", () => {
  it("keeps known false, unknown event time and true source premises distinct", async () => {
    const dataDirRoot = await mkdtemp(join(tmpdir(), "source-records-worker-"));
    const daemon = await startBenchDaemon({ dataDirRoot, embeddingMode: "disabled", fieldProjectionAdmissionMode: "explicit_checkpoint" });
    try {
      const input = (id: string, content: string, eventTime: string | null) => ({ source_id: id, source_version: "fixture",
        content_bytes: content, recorded_at: NOW, event_time: eventTime, valid_from: null, valid_to: null,
        speaker: "user" as const, scope_class: "project" as const, spans: deriveAddressableSpanViews(content) });
      const request = SoulMemorySearchRequestSchema.parse({ query: "yesterday failed deployment", max_results: 50,
        scope_class: null, dimension: null, domain_tags: null, source_observed_at: NOW,
        protocol_version: 1, supports_source_evidence: true, supported_result_kinds: ["source_evidence"],
        supports_product_updates: true, result_kind_view: "source_only" });
      const workspace = await daemon.attachWorkspace({ workspaceId: "source-workspace", runId: "source-run" });
      const negative = await workspace.importSourceRecord(input("success", "Deployment succeeded yesterday.", EVENT));
      await daemon.checkpointFieldProjection();
      const excluded = await callMcpTool<SoulMemorySearchResponse>(daemon.mcpClient, "soul.recall", request);
      expect(excluded.results).toEqual([]);
      expect(excluded.index?.completeness.logical_index).toBe("complete");
      const unknown = await workspace.importSourceRecord(input("unknown-time", "Deployment failed yesterday.", null));
      await daemon.checkpointFieldProjection();
      const unresolved = await callMcpTool<SoulMemorySearchResponse>(daemon.mcpClient, "soul.recall", request);
      expect(unresolved.results).toEqual([]);
      expect(unresolved.index?.completeness.logical_index).toBe("open");
      const positive = await workspace.importSourceRecord(input("failure", "Deployment failed yesterday.", EVENT));
      await daemon.checkpointFieldProjection();
      const accepted = await callMcpTool<SoulMemorySearchResponse>(daemon.mcpClient, "soul.recall", request);
      const ids = accepted.results.flatMap((row) => row.target.kind === "source_evidence" ? [row.target.root_id] : []);
      expect(ids).toContain(positive.record.identity);
      expect(ids).not.toContain(negative.record.identity);
      expect(ids).not.toContain(unknown.record.identity);
      const foreign = await daemon.attachWorkspace({ workspaceId: "foreign-workspace", runId: "foreign-run" });
      await expect(workspace.importSourceRecord(input("stale", "Deployment failed yesterday.", EVENT))).rejects.toThrow(/workspace/);
      const hidden = await callMcpTool<SoulMemorySearchResponse>(daemon.mcpClient, "soul.recall", request);
      expect(hidden.results).toEqual([]);
      await foreign.detach();
      await workspace.detach();
    } finally { await daemon.shutdown(); await rm(dataDirRoot, { recursive: true, force: true }); }
  }, 120000);

  it("invalidates a source continuation after another admitted record changes its pin", async () => {
    const dataDirRoot = await mkdtemp(join(tmpdir(), "source-records-pin-"));
    const daemon = await startBenchDaemon({ dataDirRoot, embeddingMode: "disabled", fieldProjectionAdmissionMode: "explicit_checkpoint" });
    try {
      const write = (id: string) => daemon.importSourceRecord({ source_id: id, source_version: "fixture", content_bytes: "source text",
        recorded_at: NOW, event_time: null, valid_from: null, valid_to: null, speaker: "user", scope_class: "project",
        spans: deriveAddressableSpanViews("source text") });
      await write("a"); await write("b"); await daemon.checkpointFieldProjection();
      const request = SoulMemorySearchRequestSchema.parse({ query: "source text", max_results: 1, scope_class: null,
        dimension: null, domain_tags: null, source_observed_at: NOW, result_kind_view: "source_only",
        protocol_version: 1, supports_source_evidence: true, supports_product_updates: true });
      const first = await callMcpTool<SoulMemorySearchResponse>(daemon.mcpClient, "soul.recall", request);
      expect(first.index?.continuation).not.toBeNull();
      await write("c"); await daemon.checkpointFieldProjection();
      const next = await callMcpTool<SoulMemorySearchResponse>(daemon.mcpClient, "soul.recall", { ...request, continuation: first.index!.continuation });
      expect(next.index?.completeness.logical_index).toBe("invalidated");
      expect(next.results).toEqual([]);
    } finally { await daemon.shutdown(); await rm(dataDirRoot, { recursive: true, force: true }); }
  }, 120000);
});
