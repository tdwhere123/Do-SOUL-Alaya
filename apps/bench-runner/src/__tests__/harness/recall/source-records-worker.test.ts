import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveAddressableSpanViews } from "@do-soul/alaya-core";
import { SoulMemorySearchRequestSchema, type SoulMemorySearchResponse } from "@do-soul/alaya-protocol";
import { startBenchDaemon } from "../../../harness/daemon.js";
import { callMcpTool } from "../../../harness/daemon/runtime/daemon-mcp-support.js";
import { HARD_IDENTITY_CAP_CONTRACT } from "../../../../../../packages/core/src/recall/conditional-field/cap-contract.js";

const NOW = "2026-09-13T00:00:00.000Z";
const EVENT = "2026-09-12T12:00:00.000Z";

describe("workspace-bound source admission through the native Recall worker", () => {
  it("binds explicit associative cap contracts through Bench worker pagination and rejects missing or incompatible contracts", async () => {
    const dataDirRoot = await mkdtemp(join(tmpdir(), "source-records-associative-"));
    const daemon = await startBenchDaemon({ dataDirRoot, embeddingMode: "disabled", fieldProjectionAdmissionMode: "explicit_checkpoint" });
    try {
      const identities: string[] = [];
      for (const id of ["a", "b", "c"]) {
        const result = await daemon.importSourceRecord({ source_id: id, source_version: "fixture", content_bytes: "source text",
          recorded_at: NOW, event_time: null, valid_from: null, valid_to: null, speaker: "user", scope_class: "project",
          spans: deriveAddressableSpanViews("source text") });
        identities.push(result.record.identity);
      }
      await daemon.checkpointFieldProjection();
      const options = { enumeration_policy: "associative" as const, result_kind_view: "source_only" as const,
        interpretationClock: NOW, maxResults: 1 };
      for (const cap_contracts of [undefined, [{ ...HARD_IDENTITY_CAP_CONTRACT, domain_id: "foreign" }]]) {
        const rejected = await daemon.recall("source text", { ...options, cap_contracts });
        expect(rejected.results).toEqual([]);
        expect(rejected.index?.completeness.logical_index).toBe("unavailable");
        expect(rejected.index?.continuation).toBeNull();
      }
      const cap_contracts = [HARD_IDENTITY_CAP_CONTRACT];
      let page = await daemon.recall("source text", { ...options, cap_contracts });
      const observed: string[] = [];
      let pages = 0;
      while (true) {
        pages++;
        expect(page.execution_receipt.compile_input.view?.cap_contracts).toEqual(cap_contracts);
        if (pages === 1) expect(page.execution_receipt.actual?.native_visits).toBeGreaterThan(0);
        expect(page.provider_calls).toBe(0);
        observed.push(...page.results.flatMap((row) => row.target.kind === "source_evidence" ? [row.target.root_id] : []));
        if (page.index?.continuation == null) break;
        expect(pages).toBeLessThan(20);
        page = await daemon.recall("source text", { ...options, cap_contracts, continuation: page.index.continuation });
      }
      expect(pages).toBeGreaterThan(1);
      expect(new Set(observed)).toEqual(new Set(identities));
      expect(observed).toHaveLength(3);
      expect(page.index?.completeness.logical_index).toBe("complete");
      expect(page.index?.completeness.interpretation_coverage).toBe("open");
    } finally { await daemon.shutdown(); await rm(dataDirRoot, { recursive: true, force: true }); }
  }, 120000);

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
