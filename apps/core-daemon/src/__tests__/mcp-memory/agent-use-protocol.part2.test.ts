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

  it("proves accept review applies durable memory update and clears pending queue", async () => {
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
        sessionId: "phase6-session-2",
        surfaceId: "phase6-agent-use-proof-accept"
      })
    });
    const client = new Client(
      { name: "phase6-agent-use-proof-accept", version: "test" },
      { capabilities: {} }
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const proposal = await callTool<SoulProposeMemoryUpdateResponse>(client, "soul.propose_memory_update", {
        target_object_id: PRIMARY_MEMORY_ID,
        proposed_changes: { content: PROPOSED_CONTENT },
        reason: "Phase 6 isolated accept-as-apply proof."
      });
      expect(proposal.status).toBe("created");

      const pendingBefore = await callTool<SoulListPendingProposalsResponse>(
        client,
        "soul.list_pending_proposals",
        { limit: 10 }
      );
      expect(pendingBefore.proposals.map((row) => row.proposal_id)).toContain(proposal.proposal_id);
      expect(pendingBefore.proposals.find((row) => row.proposal_id === proposal.proposal_id)?.proposed_changes)
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
      expect(cliPendingBefore.exitCode).toBe(0);
      expect((cliPendingBefore.json as SoulListPendingProposalsResponse).proposals.map((row) => row.proposal_id)).toEqual(
        pendingBefore.proposals.map((row) => row.proposal_id)
      );

      const review = await callTool<SoulReviewMemoryProposalResponse>(client, "soul.review_memory_proposal", {
        proposal_id: proposal.proposal_id,
        verdict: "accept",
        reason: "Apply accepted memory update.",
        reviewer_identity: "user:phase6-proof",
        reviewer_token: "phase6-review-token"
      });
      expect(review.resolution_state).toBe(ProposalResolutionState.ACCEPTED);

      const pendingAfter = await callTool<SoulListPendingProposalsResponse>(
        client,
        "soul.list_pending_proposals",
        { limit: 10 }
      );
      expect(pendingAfter.proposals.map((row) => row.proposal_id)).not.toContain(proposal.proposal_id);

      const durable = await readPhase6Evidence(dataDir, {
        deliveryId: "delivery-not-used-in-this-test",
        memoryId: PRIMARY_MEMORY_ID,
        proposalId: proposal.proposal_id,
        signalId: "signal-not-used-in-this-test"
      });
      expect(durable.proposal).toMatchObject({
        proposal_id: proposal.proposal_id,
        resolution_state: ProposalResolutionState.ACCEPTED
      });
      expect(durable.memory).toMatchObject({
        object_id: PRIMARY_MEMORY_ID,
        content: PROPOSED_CONTENT
      });
      expect(durable.eventsByType[MemoryGovernanceEventType.SOUL_MEMORY_UPDATED]).toBeGreaterThan(0);
    } finally {
      await client.close();
      await server.close();
      await runtime.shutdown();
    }
  }, PHASE6_AGENT_USE_TIMEOUT_MS);
});
