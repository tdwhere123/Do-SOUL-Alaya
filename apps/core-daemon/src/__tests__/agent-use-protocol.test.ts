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
import { ALAYA_MEMORY_TOOL_NAMES } from "../mcp-memory-tool-catalog.js";
import { createAlayaCliBridge } from "../cli/bridge.js";
import { registerAlayaCliCommands } from "../cli/register.js";
import { createAlayaDaemonRuntime, type AlayaDaemonRuntime } from "../index.js";
import { createAlayaMcpServer } from "../mcp-server.js";

const PRIMARY_MEMORY_ID = "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca";
const PROPOSED_CONTENT = "Use pnpm for workspace commands and include recall usage receipts in-memory.";
const tempDirs: string[] = [];
const originalDataDir = process.env.DATA_DIR;
const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
const originalAlayaOpenAiSecretRef = process.env.ALAYA_OPENAI_SECRET_REF;
const originalEmbeddingSupplementOptIn = process.env.ALAYA_ENABLE_EMBEDDING_SUPPLEMENT;
const originalAlayaConfigDir = process.env.ALAYA_CONFIG_DIR;
const originalCodexHome = process.env.CODEX_HOME;
const originalHome = process.env.HOME;
const originalReviewerIdentity = process.env.ALAYA_REVIEWER_IDENTITY;
const originalReviewerToken = process.env.ALAYA_REVIEWER_TOKEN;
const PHASE6_AGENT_USE_TIMEOUT_MS = 45_000;

afterEach(async () => {
  restoreProcessEnv();

  for (const directory of tempDirs.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

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

async function callTool<TOutput>(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<TOutput> {
  const result = await client.callTool({
    name,
    arguments: args
  });

  if (result.isError === true) {
    const errorText = (result.content as readonly { readonly text?: unknown }[] | undefined)
      ?.map((item) => ("text" in item && typeof item.text === "string" ? item.text : ""))
      .join("\n");
    throw new Error(`Tool call failed for ${name}: ${errorText}`);
  }
  expect(result.isError).toBeUndefined();
  const structuredContent = result.structuredContent as
    | Readonly<{ ok: true; output: TOutput }>
    | undefined;
  expect(structuredContent).toMatchObject({ ok: true });
  return structuredContent!.output;
}

async function dispatchCli(
  runtime: AlayaDaemonRuntime,
  argv: readonly string[]
): Promise<Readonly<{ exitCode: number; json?: unknown }>> {
  const bridge = createAlayaCliBridge(runtime, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    isTTY: false
  });
  registerAlayaCliCommands(bridge, runtime);
  return await bridge.dispatch(argv);
}

async function seedPhase6Fixture(dataDir: string): Promise<void> {
  const database = initDatabase({ filename: join(dataDir, "alaya.db") });
  try {
    const workspaceRepo = new SqliteWorkspaceRepo(database);
    const runRepo = new SqliteRunRepo(database);
    const memoryRepo = new SqliteMemoryEntryRepo(database);
    const proposalRepo = new SqliteProposalRepo(database);

    await workspaceRepo.create({
      workspace_id: "workspace-1",
      name: "workspace one",
      root_path: "/tmp/alaya-workspace-1",
      workspace_kind: WorkspaceKind.LOCAL_REPO,
      default_engine_binding: null,
      workspace_state: WorkspaceState.ACTIVE
    });
    await runRepo.create({
      run_id: "run-1",
      workspace_id: "workspace-1",
      title: "Phase 6 proof run",
      goal: null,
      run_mode: RunMode.CHAT,
      engine_binding_id: null,
      engine_class: null,
      run_state: RunState.IDLE,
      current_surface_id: null
    });
    await memoryRepo.create(createMemoryEntry());
    await workspaceRepo.create({
      workspace_id: "workspace-2",
      name: "workspace two",
      root_path: "/tmp/alaya-workspace-2",
      workspace_kind: WorkspaceKind.LOCAL_REPO,
      default_engine_binding: null,
      workspace_state: WorkspaceState.ACTIVE
    });
    await runRepo.create({
      run_id: "run-2",
      workspace_id: "workspace-2",
      title: "Phase 6 foreign run",
      goal: null,
      run_mode: RunMode.CHAT,
      engine_binding_id: null,
      engine_class: null,
      run_state: RunState.IDLE,
      current_surface_id: null
    });
    await proposalRepo.create({
      proposal: createForeignProposal(),
      workspace_id: "workspace-2",
      run_id: "run-2",
      target_object_kind: "memory_entry"
    });
  } finally {
    database.close();
  }
}

async function readPhase6Evidence(
  dataDir: string,
  ids: Readonly<{
    deliveryId: string;
    memoryId: string;
    proposalId: string;
    signalId: string;
  }>
): Promise<
  Readonly<{
    memory: Readonly<MemoryEntry> | null;
    proposal: Readonly<Proposal> | null;
    signal: unknown;
    usages: readonly unknown[];
    eventsByType: Readonly<Record<string, number>>;
    recallDelivered: readonly Readonly<{ payload_json: unknown }>[];
    contextUsageReported: readonly Readonly<{ payload_json: unknown }>[];
    summary: Readonly<Record<string, unknown>>;
  }>
> {
  const database = initDatabase({ filename: join(dataDir, "alaya.db") });
  const memoryRepo = new SqliteMemoryEntryRepo(database);
  const proposalRepo = new SqliteProposalRepo(database);
  const signalRepo = new SqliteSignalRepo(database);
  const trustStateRepo = new SqliteTrustStateRepo(database);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const [
    memory,
    proposal,
    signal,
    usages,
    reviewCreated,
    proposalResolved,
    memoryUpdated,
    recallDelivered,
    contextUsageReported
  ] = await Promise.all([
    memoryRepo.findById(ids.memoryId),
    proposalRepo.findById(ids.proposalId),
    signalRepo.getById(ids.signalId),
    trustStateRepo.listUsageByDeliveryIds([ids.deliveryId]),
    eventLogRepo.queryByType(MemoryGovernanceEventType.SOUL_REVIEW_CREATED),
    eventLogRepo.queryByType(MemoryGovernanceEventType.SOUL_PROPOSAL_RESOLVED),
    eventLogRepo.queryByType(MemoryGovernanceEventType.SOUL_MEMORY_UPDATED),
    eventLogRepo.queryByType(RecallContextEventType.SOUL_RECALL_DELIVERED),
    eventLogRepo.queryByType(RecallContextEventType.SOUL_CONTEXT_USAGE_REPORTED)
  ]);

  const eventsByType = {
    [MemoryGovernanceEventType.SOUL_REVIEW_CREATED]: reviewCreated.length,
    [MemoryGovernanceEventType.SOUL_PROPOSAL_RESOLVED]: proposalResolved.length,
    [MemoryGovernanceEventType.SOUL_MEMORY_UPDATED]: memoryUpdated.length,
    [RecallContextEventType.SOUL_RECALL_DELIVERED]: recallDelivered.length,
    [RecallContextEventType.SOUL_CONTEXT_USAGE_REPORTED]: contextUsageReported.length
  };

  return {
    memory,
    proposal,
    signal,
    usages,
    eventsByType,
    recallDelivered,
    contextUsageReported,
    summary: {
      proposal_state: proposal?.resolution_state ?? null,
      memory_content: memory?.content ?? null,
      usage_count: usages.length,
      signal_exists: signal !== null,
      eventsByType
    }
  };
}

function createMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: PRIMARY_MEMORY_ID,
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-05-05T00:00:00.000Z",
    updated_at: "2026-05-05T00:00:00.000Z",
    created_by: "phase6-proof",
    dimension: MemoryDimension.PREFERENCE,
    source_kind: SourceKind.USER,
    formation_kind: FormationKind.EXPLICIT,
    scope_class: ScopeClass.PROJECT,
    content: "Use pnpm for all workspace commands.",
    domain_tags: ["tooling", "workflow"],
    evidence_refs: ["phase6-proof"],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: StorageTier.HOT,
    activation_score: 0.9,
    retention_score: 0.9,
    manifestation_state: "excerpt",
    retention_state: "working",
    decay_profile: "stable",
    confidence: 1,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: 0,
    contradiction_count: 0,
    superseded_by: null,
    ...overrides
  };
}

function createForeignProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    runtime_id: "44bce795-d51c-49e8-8e60-22195c98b6ab",
    object_kind: "proposal",
    task_surface_ref: null,
    expires_at: null,
    derived_from: "8b6718fc-5d1f-4a1a-9a67-f6509fa6b8b3",
    retention_policy: "session_only",
    proposal_id: "44bce795-d51c-49e8-8e60-22195c98b6ab",
    dossier_ref: null,
    recommended_option_id: null,
    proposal_options: [
      {
        option_id: "memory_update_44bce795-d51c-49e8-8e60-22195c98b6ab",
        option_kind: "request_confirmation",
        preserves_protected_constraints: true,
        dropped_candidates: [],
        unresolved_after_apply: [],
        requires_confirmation: true
      }
    ],
    resolution_state: ProposalResolutionState.PENDING,
    last_updated_at: "2026-05-05T00:00:00.000Z",
    ...overrides
  };
}

async function createTempDataDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "alaya-phase6-agent-use-"));
  tempDirs.push(directory);
  return directory;
}

function restoreProcessEnv(): void {
  if (originalDataDir === undefined) {
    delete process.env.DATA_DIR;
  } else {
    process.env.DATA_DIR = originalDataDir;
  }

  if (originalOpenAiApiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalOpenAiApiKey;
  }

  if (originalAlayaOpenAiSecretRef === undefined) {
    delete process.env.ALAYA_OPENAI_SECRET_REF;
  } else {
    process.env.ALAYA_OPENAI_SECRET_REF = originalAlayaOpenAiSecretRef;
  }

  if (originalEmbeddingSupplementOptIn === undefined) {
    delete process.env.ALAYA_ENABLE_EMBEDDING_SUPPLEMENT;
  } else {
    process.env.ALAYA_ENABLE_EMBEDDING_SUPPLEMENT = originalEmbeddingSupplementOptIn;
  }

  if (originalAlayaConfigDir === undefined) {
    delete process.env.ALAYA_CONFIG_DIR;
  } else {
    process.env.ALAYA_CONFIG_DIR = originalAlayaConfigDir;
  }

  if (originalCodexHome === undefined) {
    delete process.env.CODEX_HOME;
  } else {
    process.env.CODEX_HOME = originalCodexHome;
  }

  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  if (originalReviewerIdentity === undefined) {
    delete process.env.ALAYA_REVIEWER_IDENTITY;
  } else {
    process.env.ALAYA_REVIEWER_IDENTITY = originalReviewerIdentity;
  }

  if (originalReviewerToken === undefined) {
    delete process.env.ALAYA_REVIEWER_TOKEN;
  } else {
    process.env.ALAYA_REVIEWER_TOKEN = originalReviewerToken;
  }
}
