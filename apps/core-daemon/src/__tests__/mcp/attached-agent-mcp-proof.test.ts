import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  FormationKind,
  HealthEventKind,
  MemoryDimension,
  GardenEventType,
  ProposalResolutionState,
  RunMode,
  RunState,
  ScopeClass,
  SourceKind,
  StorageTier,
  WorkspaceKind,
  WorkspaceState,
  type MemoryEntry,
  type SoulEmitCandidateSignalResponse,
  type SoulMemorySearchResponse,
  type SoulOpenPointerResponse,
  type SoulProposeMemoryUpdateResponse,
  type SoulReportContextUsageResponse,
  type SoulReviewMemoryProposalResponse,
  type TrustSummary
} from "@do-soul/alaya-protocol";
import {
  initDatabase,
  SqliteEventLogRepo,
  SqliteHealthJournalRepo,
  SqliteMemoryEntryRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo
} from "@do-soul/alaya-storage";
import { createAlayaCliBridge } from "../../cli/bridge.js";
import { registerAlayaCliCommands } from "../../cli/register.js";
import { createAlayaDaemonRuntime, type AlayaDaemonRuntime } from "../../index.js";
import { createAlayaMcpServer } from "../../mcp/mcp-server.js";

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
const INTEGRATION_TEST_TIMEOUT_MS = 30_000;

afterEach(async () => {
  restoreProcessEnv();

  for (const directory of tempDirs.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("Gate-4 attached-agent MCP proof", () => {
  it("drives the full soul.* memory sequence through one daemon runtime and MCP transport", async () => {
    const dataDir = await createTempDataDir();
    process.env.DATA_DIR = dataDir;
    process.env.ALAYA_OPENAI_SECRET_REF = "env:OPENAI_API_KEY";
    process.env.OPENAI_API_KEY = "test-openai-key";
    process.env.ALAYA_ENABLE_EMBEDDING_SUPPLEMENT = "false";
    process.env.ALAYA_CONFIG_DIR = join(dataDir, "config");
    process.env.CODEX_HOME = join(dataDir, "codex-home");
    process.env.HOME = join(dataDir, "home");
    process.env.ALAYA_REVIEWER_IDENTITY = "user:gate4-proof";
    process.env.ALAYA_REVIEWER_TOKEN = "gate4-review-token";
    await seedRecallFixture(dataDir);

    const runtime = await createAlayaDaemonRuntime();
    runtime.startBackgroundServices();
    const server = createAlayaMcpServer({
      memoryToolHandler: runtime.services.mcpMemoryToolHandler,
      contextProvider: () => ({
        workspaceId: "workspace-1",
        runId: "run-1",
        agentTarget: "codex",
      sessionId: "attached-agent-mcp-proof-session",
        surfaceId: "gate4-attached-agent-proof"
      })
    });
    const client = new Client(
      { name: "gate4-attached-agent-proof", version: "test" },
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
      expect(install.json).toMatchObject({ ok: true, config_dir: process.env.ALAYA_CONFIG_DIR });

      const attach = await dispatchCli(runtime, ["attach", "codex", "--yes", "--json"]);
      transcript.push({ step: "alaya attach codex --yes --json", evidence: attach.json });
      expect(attach.exitCode).toBe(0);
      expect(attach.json).toMatchObject({ ok: true, target: "codex", changed: true });

      const toolsList = await client.listTools();
      const toolNames = toolsList.tools.map((tool) => tool.name);
      transcript.push({ step: "tools/list", evidence: toolNames });
      expect(toolNames).toEqual(
        expect.arrayContaining([
          "soul.recall",
          "soul.open_pointer",
          "soul.report_context_usage",
          "soul.emit_candidate_signal",
          "soul.propose_memory_update",
          "soul.review_memory_proposal"
        ])
      );

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
      const pointer = await callTool<SoulOpenPointerResponse>(client, "soul.open_pointer", {
        object_id: objectId
      });
      transcript.push({
        step: "soul.open_pointer",
        evidence: {
          object_id: pointer.object_id,
          object_kind: pointer.object_kind
        }
      });
      expect(pointer.object_id).toBe(objectId);

      const usage = await callTool<SoulReportContextUsageResponse>(client, "soul.report_context_usage", {
        delivery_id: recall.delivery_id,
        usage_state: "used",
        used_object_ids: [objectId],
        reason: "Used by attached-agent proof."
      });
      transcript.push({ step: "soul.report_context_usage", evidence: usage });
      expect(usage).toEqual({
        delivery_id: recall.delivery_id,
        status: "recorded"
      });

      // workspace_id / run_id / surface_id are bound server-side from
      // the trusted MCP context.
      const signal = await callTool<SoulEmitCandidateSignalResponse>(client, "soul.emit_candidate_signal", {
        signal_kind: "potential_preference",
        object_kind: "memory_entry",
        scope_hint: ScopeClass.PROJECT,
        domain_tags: ["tooling"],
        confidence: 0.95,
        evidence_refs: [objectId],
        raw_payload: {
          observation: "Attached agent used the pnpm workspace preference."
        }
      });
      transcript.push({ step: "soul.emit_candidate_signal", evidence: signal });
      expect(signal.status).toBe("emitted");

      const proposal = await callTool<SoulProposeMemoryUpdateResponse>(client, "soul.propose_memory_update", {
        target_object_id: objectId,
        proposed_changes: {
          content: "Use pnpm for all workspace commands; report usage through soul.report_context_usage."
        },
        reason: "Gate-4 proof proposal path."
      });
      transcript.push({ step: "soul.propose_memory_update", evidence: proposal });
      expect(proposal.status).toBe("created");

      const review = await callTool<SoulReviewMemoryProposalResponse>(client, "soul.review_memory_proposal", {
        proposal_id: proposal.proposal_id,
        verdict: "reject",
        reason: "Gate-4 proof rejects the synthetic proposal.",
        reviewer_identity: "user:gate4-proof",
        reviewer_token: "gate4-review-token"
      });
      transcript.push({ step: "soul.review_memory_proposal", evidence: review });
      expect(review).toEqual({
        proposal_id: proposal.proposal_id,
        resolution_state: ProposalResolutionState.REJECTED
      });

      await runtime.runGardenBackgroundPass();
      const gardenEvidence = await readGardenProofEvidence(dataDir);
      expect(gardenEvidence.dispatched_events).toBeGreaterThan(0);
      expect(gardenEvidence.completed_events).toBeGreaterThan(0);
      expect(gardenEvidence.health_journal_entries).toBeGreaterThan(0);
      transcript.push({
        step: "Garden background pass",
        evidence: {
          status: "completed",
          single_runtime_lifetime: true,
          ...gardenEvidence
        }
      });

      const status = await dispatchCli(runtime, ["status", "--agent", "codex", "--json"]);
      transcript.push({ step: "alaya status --agent codex --json", evidence: status.json });
      const trust = (status.json as { readonly trust: readonly TrustSummary[] }).trust[0];
      expect(status.exitCode).toBe(0);
      expect(trust).toMatchObject({
        agent_target: "codex",
        installed_count: 1,
        configured_count: 1,
        delivered_count: 1,
        used_count: 1,
        skipped_count: 0,
        not_applicable_count: 0
      });

      const doctor = await dispatchCli(runtime, ["doctor", "--workspace", "workspace-1", "--json"]);
      transcript.push({ step: "alaya doctor --workspace workspace-1 --json", evidence: doctor.json });
      expect(doctor.exitCode).toBe(0);
      expect(doctor.json).toMatchObject({
        overall: "green",
        startup: { ready: true },
        mcp: { transport: "ready" },
        garden: { status: "healthy" }
      });

      const malformedRecall = await client.callTool({
        name: "soul.recall",
        arguments: { workspace_id: 42, situation: "" }
      });
      expect(malformedRecall.isError).toBe(true);
      transcript.push({
        step: "soul.recall (malformed args)",
        evidence: { isError: malformedRecall.isError === true }
      });

      const unknownTool = await client.callTool({
        name: "soul.unknown_tool_does_not_exist",
        arguments: {}
      });
      expect(unknownTool.isError).toBe(true);
      transcript.push({
        step: "unknown tool name",
        evidence: { isError: unknownTool.isError === true }
      });

      transcript.push({
        step: "daemon runtime lifecycle",
        evidence: {
          data_dir: dataDir,
          background_services_started: true,
          mcp_transport: "in_memory_client_server",
          single_runtime_lifetime: true
        }
      });

      expect(transcript.map((entry) => entry.step)).toEqual([
        "alaya install --non-interactive --json",
        "alaya attach codex --yes --json",
        "tools/list",
        "soul.recall",
        "soul.open_pointer",
        "soul.report_context_usage",
        "soul.emit_candidate_signal",
        "soul.propose_memory_update",
        "soul.review_memory_proposal",
        "Garden background pass",
        "alaya status --agent codex --json",
        "alaya doctor --workspace workspace-1 --json",
        "soul.recall (malformed args)",
        "unknown tool name",
        "daemon runtime lifecycle"
      ]);
    } finally {
      await client.close();
      await server.close();
      await runtime.shutdown();
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);
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

async function seedRecallFixture(dataDir: string): Promise<void> {
  const database = initDatabase({ filename: join(dataDir, "alaya.db") });
  try {
    const workspaceRepo = new SqliteWorkspaceRepo(database);
    const runRepo = new SqliteRunRepo(database);
    const memoryRepo = new SqliteMemoryEntryRepo(database);

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
      title: "Gate-4 proof run",
      goal: null,
      run_mode: RunMode.CHAT,
      engine_binding_id: null,
      engine_class: null,
      run_state: RunState.IDLE,
      current_surface_id: null
    });
    await memoryRepo.create(createMemoryEntry());
  } finally {
    database.close();
  }
}

async function readGardenProofEvidence(dataDir: string): Promise<
  Readonly<{
    dispatched_events: number;
    completed_events: number;
    health_journal_entries: number;
    health_summaries: readonly string[];
  }>
> {
  // createAlayaDaemonRuntime owns the cached SQLite connection for this DATA_DIR.
  const database = initDatabase({ filename: join(dataDir, "alaya.db") });
  const eventLogRepo = new SqliteEventLogRepo(database);
  const healthJournalRepo = new SqliteHealthJournalRepo(database);
  const [dispatched, completed, healthEntries] = await Promise.all([
    eventLogRepo.queryByType(GardenEventType.SOUL_GARDEN_TASK_DISPATCHED),
    eventLogRepo.queryByType(GardenEventType.SOUL_GARDEN_TASK_COMPLETED),
    healthJournalRepo.findByWorkspace("workspace-1", {
      kind: HealthEventKind.GARDEN_BACKLOG,
      limit: 10
    })
  ]);

  return {
    dispatched_events: dispatched.length,
    completed_events: completed.length,
    health_journal_entries: healthEntries.length,
    health_summaries: healthEntries.map((entry) => entry.summary)
  };
}

function createMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-05-01T00:00:00.000Z",
    created_by: "gate4-proof",
    dimension: MemoryDimension.PREFERENCE,
    source_kind: SourceKind.USER,
    formation_kind: FormationKind.EXPLICIT,
    scope_class: ScopeClass.PROJECT,
    content: "Use pnpm for all workspace commands.",
    domain_tags: ["tooling", "workflow"],
    evidence_refs: ["gate4-proof"],
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

async function createTempDataDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "alaya-gate4-proof-"));
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
