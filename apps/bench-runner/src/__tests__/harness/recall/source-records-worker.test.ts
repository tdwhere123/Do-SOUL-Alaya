import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveAddressableSpanViews } from "@do-soul/alaya-core";
import { SoulMemorySearchRequestSchema, type SoulMemorySearchResponse } from "@do-soul/alaya-protocol";
import { startBenchDaemon } from "../../../harness/daemon.js";
import { callMcpTool } from "../../../harness/daemon/runtime/daemon-mcp-support.js";
import { HARD_IDENTITY_CAP_CONTRACT } from "../../../../../../packages/core/src/recall/conditional-field/cap-contract.js";

import { prepareSourceRecordLexicalIndex, recallSourcePages } from "./source-records-worker-fixture.js";

const NOW = "2026-09-13T00:00:00.000Z";
const EVENT = "2026-09-12T12:00:00.000Z";

describe("workspace-bound source admission through the native Recall worker", () => {
  it("paginates native source identities without association caps and rejects retired enumeration", async () => {
    const dataDirRoot = await mkdtemp(join(tmpdir(), "source-records-native-"));
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
      const options = { enumeration_policy: "native_query" as const, result_kind_view: "source_only" as const,
        interpretationClock: NOW, maxResults: 1 };
      const unprepared = await daemon.recall("source text", options);
      expect(unprepared.results).toEqual([]);
      expect(unprepared.index?.completeness.logical_index).toBe("open");
      prepareSourceRecordLexicalIndex(daemon.dataDir, daemon.workspaceId);
      // Historical identities still parse, but even a valid former cap cannot execute them.
      for (const enumeration_policy of ["canonical", "associative"] as const) {
        for (const cap_contracts of [undefined, [HARD_IDENTITY_CAP_CONTRACT], [{ ...HARD_IDENTITY_CAP_CONTRACT, domain_id: "foreign" }]]) {
          const historical = SoulMemorySearchRequestSchema.safeParse({ query: "source text", enumeration_policy, cap_contracts,
            scope_class: null, dimension: null, domain_tags: null, max_results: 1 });
          expect(historical.success).toBe(enumeration_policy !== "associative" || cap_contracts !== undefined);
          await expect(daemon.recall("source text", { ...options, enumeration_policy, cap_contracts }))
            .rejects.toThrow("Legacy Recall enumeration policies are read-only; ordinary execution requires native_query");
        }
      }
      let page = await daemon.recall("source text", options);
      const observed: string[] = [];
      let pages = 0;
      while (true) {
        pages++;
        expect(page.execution_receipt.compile_input.view?.enumeration_policy).toBe("native_query");
        expect(page.index?.entries.every(entry => entry.navigation?.operator === "source_lexical")).toBe(true);
        if (pages === 1) expect(page.execution_receipt.actual?.native_visits).toBeGreaterThan(0);
        expect(page.provider_calls).toBe(0);
        observed.push(...page.results.flatMap((row) => row.target.kind === "source_evidence" ? [row.target.root_id] : []));
        if (page.index?.continuation == null) break;
        expect(pages).toBeLessThan(20);
        page = await daemon.recall("source text", { ...options, continuation: page.index.continuation });
      }
      expect(pages).toBeGreaterThan(1);
      expect(new Set(observed)).toEqual(new Set(identities));
      expect(observed).toHaveLength(3);
      // Issued membership pages are exhausted, but the absent vector lane is not complete.
      expect(page.index?.completeness.logical_index).toBe("open");
      expect(page.index?.completeness.interpretation_coverage).toBe("open");
    } finally { await daemon.shutdown(); await rm(dataDirRoot, { recursive: true, force: true }); }
  }, 120000);

  it("keeps known false, unknown event time and true source premises distinct", async () => {
    const dataDirRoot = await mkdtemp(join(tmpdir(), "source-records-worker-"));
    const daemon = await startBenchDaemon({ dataDirRoot, embeddingMode: "disabled", fieldProjectionAdmissionMode: "explicit_checkpoint" });
    try {
      const input = (id: string, content: string, eventTime: string | null) => ({ source_id: id, source_version: "fixture",
        content_bytes: content, recorded_at: NOW, event_time: eventTime, valid_from: null, valid_to: null,
        speaker: "user" as const, scope_class: "project" as const, source_representation: { kind: "original_body" as const },
        spans: deriveAddressableSpanViews(content) });
      const request = SoulMemorySearchRequestSchema.parse({ query: "yesterday failed deployment", max_results: 50,
        scope_class: null, dimension: null, domain_tags: null, source_observed_at: NOW,
        protocol_version: 1, supports_source_evidence: true, supported_result_kinds: ["source_evidence"],
        supports_product_updates: true, result_kind_view: "source_only" });
      const workspace = await daemon.attachWorkspace({ workspaceId: "source-workspace", runId: "source-run" });
      const negative = await workspace.importSourceRecord(input("success", "Deployment succeeded yesterday.", EVENT));
      await daemon.checkpointFieldProjection();
      prepareSourceRecordLexicalIndex(daemon.dataDir, workspace.workspaceId);
      const excluded = await recallSourcePages(daemon, request);
      expect(excluded.results).toEqual([]);
      expect(excluded.response.index?.completeness.logical_index).toBe("open");
      const unknown = await workspace.importSourceRecord(input("unknown-time", "Deployment failed yesterday.", null));
      await daemon.checkpointFieldProjection();
      prepareSourceRecordLexicalIndex(daemon.dataDir, workspace.workspaceId);
      const unresolved = await recallSourcePages(daemon, request);
      expect(unresolved.results).toEqual([]);
      expect(unresolved.response.index?.completeness.logical_index).toBe("open");
      const positive = await workspace.importSourceRecord(input("failure", "Deployment failed yesterday.", EVENT));
      await daemon.checkpointFieldProjection();
      prepareSourceRecordLexicalIndex(daemon.dataDir, workspace.workspaceId);
      const accepted = await recallSourcePages(daemon, request);
      const ids = accepted.results.flatMap((row) => row.target.kind === "source_evidence" ? [row.target.root_id] : []);
      expect(ids).toContain(positive.record.identity);
      expect(ids).not.toContain(negative.record.identity);
      expect(ids).not.toContain(unknown.record.identity);
      // The unknown-time record remains independently accessible, not known false
      // or absent. Neither failure text nor admission time may invent its event time.
      const raw = await recallSourcePages(daemon, { ...request, query: "deployment" });
      expect(new Set(raw.results.flatMap(row => row.target.kind === "source_evidence" ? [row.target.root_id] : [])))
        .toEqual(new Set([negative.record.identity, unknown.record.identity, positive.record.identity]));
      const foreign = await daemon.attachWorkspace({ workspaceId: "foreign-workspace", runId: "foreign-run" });
      await expect(workspace.importSourceRecord(input("stale", "Deployment failed yesterday.", EVENT))).rejects.toThrow(/workspace/);
      const hidden = await recallSourcePages(daemon, request);
      expect(hidden.results).toEqual([]);
      await foreign.detach();
      await workspace.detach();
    } finally { await daemon.shutdown(); await rm(dataDirRoot, { recursive: true, force: true }); }
  }, 120000);

  it("invalidates a source continuation after an admitted source revision changes its pin", async () => {
    const dataDirRoot = await mkdtemp(join(tmpdir(), "source-records-pin-"));
    const daemon = await startBenchDaemon({ dataDirRoot, embeddingMode: "disabled", fieldProjectionAdmissionMode: "explicit_checkpoint" });
    try {
      const write = (id: string, version = "fixture", body = "source text") => daemon.importSourceRecord({
        source_id: id, source_version: version, content_bytes: body,
        recorded_at: NOW, event_time: null, valid_from: null, valid_to: null, speaker: "user", scope_class: "project",
        spans: deriveAddressableSpanViews(body) });
      const original = await write("a"); await write("b"); await daemon.checkpointFieldProjection();
      prepareSourceRecordLexicalIndex(daemon.dataDir, daemon.workspaceId);
      const request = SoulMemorySearchRequestSchema.parse({ query: "source text", max_results: 1, scope_class: null,
        dimension: null, domain_tags: null, source_observed_at: NOW, result_kind_view: "source_only",
        protocol_version: 1, supports_source_evidence: true, supports_product_updates: true });
      const first = await callMcpTool<SoulMemorySearchResponse>(daemon.mcpClient, "soul.recall", request);
      expect(first.index?.continuation).toBeDefined();
      expect(first.index?.continuation).not.toBeNull();
      const revised = await write("a", "revised", "revised source text");
      expect(revised.record.identity).not.toBe(original.record.identity);
      expect(revised.record.content_digest).not.toBe(original.record.content_digest);
      expect(revised.record.source_id).toBe(original.record.source_id);
      await daemon.checkpointFieldProjection();
      const next = await callMcpTool<SoulMemorySearchResponse>(daemon.mcpClient, "soul.recall", { ...request, continuation: first.index!.continuation });
      expect(next.index?.completeness.logical_index).toBe("invalidated");
      expect(next.results).toEqual([]);
    } finally { await daemon.shutdown(); await rm(dataDirRoot, { recursive: true, force: true }); }
  }, 120000);
});
