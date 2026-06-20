import { mkdtemp, rm } from "node:fs/promises";

import { tmpdir } from "node:os";

import { join } from "node:path";

import { PassThrough } from "node:stream";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";

import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { afterEach, describe, expect, it } from "vitest";

import {
  FormationKind,
  MemoryDimension,
  MemoryGovernanceEventType,
  parseRecallContextEventPayload,
  ProposalResolutionState,
  RecallContextEventType,
  RunMode,
  RunState,
  ScopeClass,
  SourceKind,
  StorageTier,
  WorkspaceKind,
  WorkspaceState,
  type MemoryEntry,
  type Proposal,
  type SoulEmitCandidateSignalResponse,
  type SoulListPendingProposalsResponse,
  type SoulMemorySearchResponse,
  type SoulOpenPointerResponse,
  type SoulProposeMemoryUpdateResponse,
  type SoulReportContextUsageResponse,
  type SoulReviewMemoryProposalResponse
} from "@do-soul/alaya-protocol";

import {
  initDatabase,
  SqliteEventLogRepo,
  SqliteMemoryEntryRepo,
  SqliteProposalRepo,
  SqliteRunRepo,
  SqliteSignalRepo,
  SqliteTrustStateRepo,
  SqliteWorkspaceRepo
} from "@do-soul/alaya-storage";

import { ALAYA_MEMORY_TOOL_NAMES } from "../../mcp-memory/tool-catalog.js";

import { createAlayaCliBridge } from "../../cli/bridge.js";

import { registerAlayaCliCommands } from "../../cli/register.js";

import { createAlayaDaemonRuntime, type AlayaDaemonRuntime } from "../../index.js";

import { createAlayaMcpServer } from "../../mcp/mcp-server.js";

import {
  PRIMARY_MEMORY_ID,
  PROPOSED_CONTENT,
  tempDirs,
  originalDataDir,
  originalOpenAiApiKey,
  originalAlayaOpenAiSecretRef,
  originalEmbeddingSupplementOptIn,
  originalAlayaConfigDir,
  originalCodexHome,
  originalHome,
  originalReviewerIdentity,
  originalReviewerToken,
  PHASE6_AGENT_USE_TIMEOUT_MS,
  callTool,
  dispatchCli,
  seedPhase6Fixture,
  readPhase6Evidence,
  createMemoryEntry,
  createForeignProposal,
  createTempDataDir,
  restoreProcessEnv
} from "./agent-use-protocol-fixture.js";

describe("Phase-6 MCP agent-use protocol proof", () => {

  it("proves ordered MCP calls, CLI parity, and accept-path durability in one daemon lifetime", async () => {
    const dataDir = await createTempDataDir();
    process.env.DATA_DIR = dataDir;
    process.env.ALAYA_OPENAI_SECRET_REF = "env:OPENAI_API_KEY";
    process.env.OPENAI_API_KEY = "test-openai-key";
    process.env.ALAYA_ENABLE_EMBEDDING_SUPPLEMENT = "false";
    process.env.ALAYA_CONFIG_DIR = join(dataDir, "config");
    process.env.CODEX_HOME = join(dataDir, "codex-home");
    process.env.HOME = join(dataDir, "home");
    process.env.ALAYA_REVIEWER_IDENTITY = "user:phase6-proof";
    process.env.ALAYA_REVIEWER_TOKEN = "phase6-review-token";
    await seedPhase6Fixture(dataDir);

    const runtime = await createAlayaDaemonRuntime();
    runtime.startBackgroundServices();
    const server = createAlayaMcpServer({
      memoryToolHandler: runtime.services.mcpMemoryToolHandler,
      contextProvider: () => ({
        workspaceId: "workspace-1",
        runId: "run-1",
        agentTarget: "codex",
        sessionId: "phase6-session-1",
        surfaceId: "phase6-agent-use-proof"
      })
    });
    const client = new Client(
      { name: "phase6-agent-use-proof", version: "test" },
      { capabilities: {} }
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const transcript: Array<Readonly<{ step: string; evidence: unknown }>> = [];

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const install = await dispatchCli(runtime, [
        "install",
        "--non-interactive",
        JSON.stringify({
          db_path: join(dataDir, "alaya.db"),
          embedding_enabled: false,
          default_workspace: "workspace-1",
          worktree_enabled: false
        }),
        "--json"
      ]);
      transcript.push({ step: "alaya install --non-interactive --json", evidence: install.json });
      expect(install.exitCode).toBe(0);

      const attach = await dispatchCli(runtime, ["attach", "codex", "--yes", "--json"]);
      transcript.push({ step: "alaya attach codex --yes --json", evidence: attach.json });
      expect(attach.exitCode).toBe(0);

      const toolsList = await client.listTools();
      const mcpToolNames = toolsList.tools.map((tool) => tool.name);
      transcript.push({ step: "MCP tools/list", evidence: mcpToolNames });
      expect(mcpToolNames).toEqual([...ALAYA_MEMORY_TOOL_NAMES]);

      const cliToolsList = await dispatchCli(runtime, ["tools", "list", "--json"]);
      const cliToolNames = (cliToolsList.json as { tools: readonly { name: string }[] }).tools.map(
        (tool) => tool.name
      );
      transcript.push({ step: "alaya tools list --json", evidence: cliToolNames });
      expect(cliToolsList.exitCode).toBe(0);
      expect(cliToolNames).toEqual(mcpToolNames);

      const recall = await callTool<SoulMemorySearchResponse>(client, "soul.recall", {
        query: "pnpm workspace commands",
        scope_class: ScopeClass.PROJECT,
        dimension: MemoryDimension.PREFERENCE,
        domain_tags: null,
        max_results: 3
      });
      transcript.push({
        step: "soul.recall",
        evidence: {
          delivery_id: recall.delivery_id,
          result_count: recall.results.length,
          delivered_object_ids: recall.results.map((result) => result.object_id)
        }
      });
      expect(recall.results).toHaveLength(1);

      const objectId = recall.results[0]!.object_id;
      expect(objectId).toBe(PRIMARY_MEMORY_ID);
      const pointer = await callTool<SoulOpenPointerResponse>(client, "soul.open_pointer", {
        object_id: objectId
      });
      transcript.push({
        step: "soul.open_pointer",
        evidence: { object_id: pointer.object_id, content: pointer.content.content }
      });
      expect(pointer.content.content).toBe("Use pnpm for all workspace commands.");

      const usage = await callTool<SoulReportContextUsageResponse>(client, "soul.report_context_usage", {
        delivery_id: recall.delivery_id,
        usage_state: "used",
        used_object_ids: [objectId],
        reason: "Phase 6 proof consumed recalled memory."
      });
      transcript.push({ step: "soul.report_context_usage", evidence: usage });
      expect(usage).toEqual({ delivery_id: recall.delivery_id, status: "recorded" });

      // workspace_id / run_id / surface_id are stripped from the public
      // MCP schema. The daemon binds them from the trusted MCP call
      // context via mcpMemoryToolHandler.
      const signal = await callTool<SoulEmitCandidateSignalResponse>(client, "soul.emit_candidate_signal", {
        signal_kind: "potential_preference",
        object_kind: "memory_entry",
        scope_hint: ScopeClass.PROJECT,
        domain_tags: ["tooling"],
        confidence: 0.95,
        evidence_refs: [objectId],
        raw_payload: {
          observation: "Agent used project-scoped pnpm preference and reported usage."
        }
      });
      transcript.push({ step: "soul.emit_candidate_signal", evidence: signal });
      expect(signal.status).toBe("emitted");

      const proposal = await callTool<SoulProposeMemoryUpdateResponse>(client, "soul.propose_memory_update", {
        target_object_id: objectId,
        proposed_changes: { content: PROPOSED_CONTENT },
        reason: "Phase 6 proof proposal for accept-as-apply."
      });
      transcript.push({ step: "soul.propose_memory_update", evidence: proposal });
      expect(proposal.status).toBe("created");

      const mcpPendingBefore = await callTool<SoulListPendingProposalsResponse>(
        client,
        "soul.list_pending_proposals",
        { limit: 10 }
      );
      transcript.push({
        step: "soul.list_pending_proposals",
        evidence: mcpPendingBefore.proposals.map((row) => row.proposal_id)
      });
      expect(mcpPendingBefore.proposals.map((row) => row.proposal_id)).toContain(proposal.proposal_id);
      expect(mcpPendingBefore.proposals.find((row) => row.proposal_id === proposal.proposal_id)?.proposed_changes)
        .toEqual({ content: PROPOSED_CONTENT });

      const cliPendingBefore = await dispatchCli(runtime, [
        "review",
        "pending",
        "--workspace",
        "workspace-1",
        "--run",
        "run-1",
        "--agent",
        "codex",
        "--json"
      ]);
      const cliPendingBeforeIds = (
        cliPendingBefore.json as SoulListPendingProposalsResponse
      ).proposals.map((row) => row.proposal_id);
      transcript.push({ step: "alaya review pending --json", evidence: cliPendingBeforeIds });
      expect(cliPendingBefore.exitCode).toBe(0);
      expect(cliPendingBeforeIds).toEqual(mcpPendingBefore.proposals.map((row) => row.proposal_id));

      const review = await callTool<SoulReviewMemoryProposalResponse>(client, "soul.review_memory_proposal", {
        proposal_id: proposal.proposal_id,
        verdict: "accept",
        reason: "Phase 6 proof accepts proposal to validate durable apply.",
        reviewer_identity: "user:phase6-proof",
        reviewer_token: "phase6-review-token"
      });
      transcript.push({ step: "soul.review_memory_proposal", evidence: review });
      expect(review).toEqual({
        proposal_id: proposal.proposal_id,
        resolution_state: ProposalResolutionState.ACCEPTED
      });

      const mcpPendingAfter = await callTool<SoulListPendingProposalsResponse>(
        client,
        "soul.list_pending_proposals",
        { limit: 10 }
      );
      transcript.push({
        step: "soul.list_pending_proposals (after accept)",
        evidence: mcpPendingAfter.proposals.map((row) => row.proposal_id)
      });
      expect(mcpPendingAfter.proposals.map((row) => row.proposal_id)).not.toContain(proposal.proposal_id);

      const cliPendingAfter = await dispatchCli(runtime, [
        "review",
        "pending",
        "--workspace",
        "workspace-1",
        "--run",
        "run-1",
        "--agent",
        "codex",
        "--json"
      ]);
      const cliPendingAfterIds = (
        cliPendingAfter.json as SoulListPendingProposalsResponse
      ).proposals.map((row) => row.proposal_id);
      transcript.push({ step: "alaya review pending --json (after accept)", evidence: cliPendingAfterIds });
      expect(cliPendingAfter.exitCode).toBe(0);
      expect(cliPendingAfterIds).toEqual(mcpPendingAfter.proposals.map((row) => row.proposal_id));

      const durable = await readPhase6Evidence(dataDir, {
        deliveryId: recall.delivery_id,
        memoryId: objectId,
        proposalId: proposal.proposal_id,
        signalId: signal.signal_id
      });
      transcript.push({ step: "durable evidence after governance accept", evidence: durable.summary });
      expect(durable.proposal).toMatchObject({
        proposal_id: proposal.proposal_id,
        resolution_state: ProposalResolutionState.ACCEPTED
      });
      expect(durable.memory).toMatchObject({
        object_id: objectId,
        content: PROPOSED_CONTENT
      });
      expect(durable.usages).toHaveLength(1);
      expect(durable.eventsByType[MemoryGovernanceEventType.SOUL_REVIEW_CREATED]).toBeGreaterThan(0);
      expect(durable.eventsByType[MemoryGovernanceEventType.SOUL_PROPOSAL_RESOLVED]).toBeGreaterThan(0);
      expect(durable.eventsByType[MemoryGovernanceEventType.SOUL_MEMORY_UPDATED]).toBeGreaterThan(0);
      expect(durable.eventsByType[RecallContextEventType.SOUL_RECALL_DELIVERED]).toBeGreaterThan(0);
      expect(durable.eventsByType[RecallContextEventType.SOUL_CONTEXT_USAGE_REPORTED]).toBeGreaterThan(0);

      const deliveredRow = durable.recallDelivered.find((row) => {
        const parsed = parseRecallContextEventPayload(
          RecallContextEventType.SOUL_RECALL_DELIVERED,
          row.payload_json as Record<string, unknown>
        );
        return parsed.delivery_id === recall.delivery_id;
      });
      expect(deliveredRow).toBeDefined();
      const deliveredPayload = parseRecallContextEventPayload(
        RecallContextEventType.SOUL_RECALL_DELIVERED,
        deliveredRow!.payload_json as Record<string, unknown>
      );
      expect(deliveredPayload.pointer_count).toBe(recall.results.length);
      expect(deliveredPayload.query_hash).toMatch(/^[a-f0-9]{16}$/);
      expect(deliveredPayload.latency_ms).toBeGreaterThanOrEqual(0);
      expect(deliveredPayload.agent_target.length).toBeGreaterThan(0);
      expect(deliveredPayload.workspace_id).toBe("workspace-1");

      const usageRow = durable.contextUsageReported.find((row) => {
        const parsed = parseRecallContextEventPayload(
          RecallContextEventType.SOUL_CONTEXT_USAGE_REPORTED,
          row.payload_json as Record<string, unknown>
        );
        return parsed.delivery_id === recall.delivery_id;
      });
      expect(usageRow).toBeDefined();
      const usagePayload = parseRecallContextEventPayload(
        RecallContextEventType.SOUL_CONTEXT_USAGE_REPORTED,
        usageRow!.payload_json as Record<string, unknown>
      );
      expect(usagePayload.usage_state).toBe("used");
      expect(usagePayload.workspace_id).toBe("workspace-1");

      const secondRecall = await callTool<SoulMemorySearchResponse>(client, "soul.recall", {
        query: "pnpm workspace commands",
        scope_class: ScopeClass.PROJECT,
        dimension: MemoryDimension.PREFERENCE,
        domain_tags: null,
        max_results: 3
      });
      transcript.push({
        step: "soul.recall (after accept)",
        evidence: secondRecall.results.map((result) => ({
          object_id: result.object_id,
          relevance_score: result.relevance_score,
          content_preview: result.content_preview,
          evidence_pointers: result.evidence_pointers
        }))
      });
      expect(secondRecall.results[0]?.object_id).toBe(objectId);
      expect(secondRecall.results[0]?.content_preview).toContain("include recall usage receipts");
      expect(secondRecall.results[0]?.evidence_pointers.length ?? 0).toBeGreaterThan(0);

      expect(transcript.map((entry) => entry.step)).toEqual([
        "alaya install --non-interactive --json",
        "alaya attach codex --yes --json",
        "MCP tools/list",
        "alaya tools list --json",
        "soul.recall",
        "soul.open_pointer",
        "soul.report_context_usage",
        "soul.emit_candidate_signal",
        "soul.propose_memory_update",
        "soul.list_pending_proposals",
        "alaya review pending --json",
        "soul.review_memory_proposal",
        "soul.list_pending_proposals (after accept)",
        "alaya review pending --json (after accept)",
        "durable evidence after governance accept",
        "soul.recall (after accept)"
      ]);
    } finally {
      await client.close();
      await server.close();
      await runtime.shutdown();
    }
  }, PHASE6_AGENT_USE_TIMEOUT_MS);
});
