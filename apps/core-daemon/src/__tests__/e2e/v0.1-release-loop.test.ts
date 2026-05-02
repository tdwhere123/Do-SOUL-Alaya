import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  Phase4AEventType,
  ProposalResolutionState,
  RunMode,
  RunState,
  ScopeClass,
  SignalState,
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
  SqliteProposalRepo,
  SqliteRunRepo,
  SqliteSignalRepo,
  SqliteTrustStateRepo,
  SqliteWorkspaceRepo
} from "@do-soul/alaya-storage";
import { ALAYA_MEMORY_TOOL_NAMES } from "../../mcp-memory-tool-catalog.js";
import { createAlayaCliBridge } from "../../cli/bridge.js";
import { registerAlayaCliCommands } from "../../cli/register.js";
import { createAlayaDaemonRuntime, type AlayaDaemonRuntime } from "../../index.js";
import { createAlayaMcpServer } from "../../mcp-server.js";

const tempDirs: string[] = [];
const originalDataDir = process.env.DATA_DIR;
const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
const originalAlayaOpenAiSecretRef = process.env.ALAYA_OPENAI_SECRET_REF;
const originalEmbeddingSupplementOptIn = process.env.ALAYA_ENABLE_EMBEDDING_SUPPLEMENT;
const originalAlayaConfigDir = process.env.ALAYA_CONFIG_DIR;
const originalCodexHome = process.env.CODEX_HOME;
const originalHome = process.env.HOME;
const RELEASE_LOOP_TIMEOUT_MS = 45_000;

afterEach(async () => {
  restoreProcessEnv();

  for (const directory of tempDirs.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("P5 v0.1 release loop E2E", () => {
  it("proves the release-critical MCP and CLI memory loop in one daemon lifetime", async () => {
    const dataDir = await createTempDataDir();
    process.env.DATA_DIR = dataDir;
    process.env.ALAYA_OPENAI_SECRET_REF = "env:OPENAI_API_KEY";
    process.env.OPENAI_API_KEY = "test-openai-key";
    process.env.ALAYA_ENABLE_EMBEDDING_SUPPLEMENT = "false";
    process.env.ALAYA_CONFIG_DIR = join(dataDir, "config");
    process.env.CODEX_HOME = join(dataDir, "codex-home");
    process.env.HOME = join(dataDir, "home");
    await seedReleaseFixture(dataDir);

    const runtime = await createAlayaDaemonRuntime();
    runtime.startBackgroundServices();
    const server = createAlayaMcpServer({
      memoryToolHandler: runtime.services.mcpMemoryToolHandler,
      contextProvider: () => ({
        workspaceId: "workspace-1",
        runId: "run-1",
        agentTarget: "codex",
        surfaceId: "p5-release-loop"
      })
    });
    const client = new Client(
      { name: "p5-release-loop", version: "test" },
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
      transcript.push({ step: "MCP tools/list", evidence: toolNames });
      expect(toolNames).toEqual([...ALAYA_MEMORY_TOOL_NAMES]);
      expect(toolNames.some((toolName) => toolName.startsWith("memory."))).toBe(false);

      const cliToolsList = await dispatchCli(runtime, ["tools", "list", "--json"]);
      const cliToolNames = (cliToolsList.json as { tools: readonly { name: string }[] }).tools.map(
        (tool) => tool.name
      );
      transcript.push({ step: "alaya tools list --json", evidence: cliToolNames });
      expect(cliToolsList.exitCode).toBe(0);
      expect(cliToolNames).toEqual(toolNames);

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
      expect(pointer.content).toMatchObject({
        object_id: objectId,
        content: "Use pnpm for all workspace commands."
      });

      const cliPointer = await dispatchCli(runtime, [
        "tools",
        "call",
        "soul.open_pointer",
        JSON.stringify({ object_id: objectId }),
        "--workspace",
        "workspace-1",
        "--run",
        "run-1",
        "--agent",
        "codex",
        "--json"
      ]);
      transcript.push({ step: "alaya tools call soul.open_pointer --json", evidence: cliPointer.json });
      expect(cliPointer.exitCode).toBe(0);
      expect(cliPointer.json).toMatchObject({
        object_id: objectId,
        content: { content: "Use pnpm for all workspace commands." }
      });

      const usage = await callTool<SoulReportContextUsageResponse>(client, "soul.report_context_usage", {
        delivery_id: recall.delivery_id,
        usage_state: "used",
        used_object_ids: [objectId],
        reason: "Used by P5 release-loop proof."
      });
      transcript.push({ step: "soul.report_context_usage", evidence: usage });
      expect(usage).toEqual({
        delivery_id: recall.delivery_id,
        status: "recorded"
      });

      const beforeProposal = await readMemoryEntry(dataDir, objectId);
      expect(beforeProposal?.content).toBe("Use pnpm for all workspace commands.");

      const signal = await callTool<SoulEmitCandidateSignalResponse>(client, "soul.emit_candidate_signal", {
        workspace_id: "workspace-1",
        run_id: "run-1",
        surface_id: "p5-release-loop",
        signal_kind: "potential_preference",
        object_kind: "memory_entry",
        scope_hint: ScopeClass.PROJECT,
        domain_tags: ["tooling"],
        confidence: 0.95,
        evidence_refs: [objectId],
        raw_payload: {
          observation: "Release loop used the pnpm workspace preference."
        }
      });
      transcript.push({ step: "soul.emit_candidate_signal", evidence: signal });
      expect(signal.status).toBe("emitted");

      const proposal = await callTool<SoulProposeMemoryUpdateResponse>(client, "soul.propose_memory_update", {
        target_object_id: objectId,
        proposed_changes: {
          content: "Use pnpm for workspace commands and always record recall usage."
        },
        reason: "P5 release-loop synthetic proposal."
      });
      transcript.push({ step: "soul.propose_memory_update", evidence: proposal });
      expect(proposal.status).toBe("created");

      const review = await callTool<SoulReviewMemoryProposalResponse>(client, "soul.review_memory_proposal", {
        proposal_id: proposal.proposal_id,
        verdict: "reject",
        reason: "P5 release-loop rejects the synthetic proposal."
      });
      transcript.push({ step: "soul.review_memory_proposal", evidence: review });
      expect(review).toEqual({
        proposal_id: proposal.proposal_id,
        resolution_state: ProposalResolutionState.REJECTED
      });

      const postReject = await readReleaseEvidence(dataDir, {
        deliveryId: recall.delivery_id,
        objectId,
        proposalId: proposal.proposal_id,
        signalId: signal.signal_id
      });
      transcript.push({ step: "durable evidence after governance reject", evidence: postReject.summary });
      expect(postReject.memory).toMatchObject({
        object_id: objectId,
        content: beforeProposal!.content,
        updated_at: beforeProposal!.updated_at
      });
      expect(postReject.proposal).toMatchObject({
        proposal_id: proposal.proposal_id,
        resolution_state: ProposalResolutionState.REJECTED
      });
      expect(postReject.signal).toMatchObject({
        signal_id: signal.signal_id,
        signal_state: SignalState.MATERIALIZED
      });
      expect(postReject.delivery).toMatchObject({
        delivery_id: recall.delivery_id,
        agent_target: "codex",
        delivered_object_ids: [objectId]
      });
      expect(postReject.usages).toHaveLength(1);
      expect(postReject.usages[0]).toMatchObject({
        delivery_id: recall.delivery_id,
        usage_state: "used",
        used_object_ids: [objectId]
      });

      await runtime.runGardenBackgroundPass();
      const gardenEvidence = await readGardenEvidence(dataDir);
      transcript.push({
        step: "Garden background pass",
        evidence: {
          status: "completed",
          single_runtime_lifetime: true,
          ...gardenEvidence
        }
      });
      expect(gardenEvidence.dispatched_events).toBeGreaterThan(0);
      expect(gardenEvidence.completed_events).toBeGreaterThan(0);
      expect(gardenEvidence.health_journal_entries).toBeGreaterThan(0);

      const status = await dispatchCli(runtime, ["status", "--agent", "codex", "--json"]);
      const trust = (status.json as { readonly trust: readonly TrustSummary[] }).trust[0];
      transcript.push({ step: "alaya status --agent codex --json", evidence: status.json });
      expect(status.exitCode).toBe(0);
      expect((status.json as { readonly garden: { readonly last_pass_at: string | null } }).garden.last_pass_at)
        .not.toBeNull();
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
        garden: { status: "healthy", last_pass_at: expect.any(String) }
      });

      const backupPath = join(dataDir, "release-backup.json");
      const backup = await dispatchCli(runtime, ["backup", "--output", backupPath, "--json"]);
      const backupBundle = await readOperationBundle(backupPath);
      transcript.push({ step: "alaya backup --output --json", evidence: backup.json });
      expect(backup.exitCode).toBe(0);
      expect(backup.json).toMatchObject({ artifact_path: backupPath });
      expect(backupBundle.kind).toBe("backup");
      expect(backupBundle.storage.db_base64.length).toBeGreaterThan(0);

      const exportPath = join(dataDir, "release-export.json");
      const exportResult = await dispatchCli(runtime, ["export", "--output", exportPath, "--json"]);
      const exportBundle = await readOperationBundle(exportPath);
      transcript.push({ step: "alaya export --output --json", evidence: exportResult.json });
      expect(exportResult.exitCode).toBe(0);
      expect(exportResult.json).toMatchObject({ artifact_path: exportPath });
      expect(exportBundle.kind).toBe("export");
      expect(exportBundle.storage.db_base64.length).toBeGreaterThan(0);

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
        "MCP tools/list",
        "alaya tools list --json",
        "soul.recall",
        "soul.open_pointer",
        "alaya tools call soul.open_pointer --json",
        "soul.report_context_usage",
        "soul.emit_candidate_signal",
        "soul.propose_memory_update",
        "soul.review_memory_proposal",
        "durable evidence after governance reject",
        "Garden background pass",
        "alaya status --agent codex --json",
        "alaya doctor --workspace workspace-1 --json",
        "alaya backup --output --json",
        "alaya export --output --json",
        "daemon runtime lifecycle"
      ]);
    } finally {
      await client.close();
      await server.close();
      await runtime.shutdown();
    }
  }, RELEASE_LOOP_TIMEOUT_MS);

  it("uses installed config storage when DATA_DIR differs", async () => {
    const dataDir = await createTempDataDir();
    const configDir = join(dataDir, "config");
    const configuredDbPath = join(dataDir, "configured-storage", "alaya.db");
    const misleadingDataDir = join(dataDir, "misleading-data-dir");
    process.env.DATA_DIR = misleadingDataDir;
    process.env.ALAYA_OPENAI_SECRET_REF = "env:OPENAI_API_KEY";
    process.env.OPENAI_API_KEY = "test-openai-key";
    process.env.ALAYA_ENABLE_EMBEDDING_SUPPLEMENT = "false";
    process.env.ALAYA_CONFIG_DIR = configDir;
    process.env.CODEX_HOME = join(dataDir, "codex-home");
    process.env.HOME = join(dataDir, "home");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "alaya.toml"),
      `[storage]\ndb_path = "${configuredDbPath}"\n`,
      "utf8"
    );
    await seedReleaseFixtureAtDbPath(configuredDbPath);

    const runtime = await createAlayaDaemonRuntime();
    runtime.startBackgroundServices();
    const server = createAlayaMcpServer({
      memoryToolHandler: runtime.services.mcpMemoryToolHandler,
      contextProvider: () => ({
        workspaceId: "workspace-1",
        runId: "run-1",
        agentTarget: "codex",
        surfaceId: "p5-config-storage"
      })
    });
    const client = new Client(
      { name: "p5-config-storage", version: "test" },
      { capabilities: {} }
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const recall = await callTool<SoulMemorySearchResponse>(client, "soul.recall", {
        query: "pnpm workspace commands",
        scope_class: ScopeClass.PROJECT,
        dimension: MemoryDimension.PREFERENCE,
        domain_tags: null,
        max_results: 3
      });
      expect(recall.results.map((result) => result.object_id)).toEqual([
        "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca"
      ]);

      await runtime.runGardenBackgroundPass();

      const status = await dispatchCli(runtime, ["status", "--agent", "codex", "--json"]);
      expect(status.exitCode).toBe(0);
      expect(status.json).toMatchObject({
        daemon: { up: true },
        garden: { last_pass_at: expect.any(String) }
      });

      const doctor = await dispatchCli(runtime, ["doctor", "--workspace", "workspace-1", "--json"]);
      expect(doctor.exitCode).toBe(0);
      expect(doctor.json).toMatchObject({
        garden: { status: "healthy", last_pass_at: expect.any(String) },
        storage: {
          db_path: configuredDbPath,
          exists: true,
          writable: true
        }
      });

      const backupPath = join(dataDir, "configured-backup.json");
      const backup = await dispatchCli(runtime, ["backup", "--output", backupPath, "--json"]);
      const backupBundle = await readOperationBundle(backupPath);
      expect(backup.exitCode).toBe(0);
      expect(backupBundle.storage.db_path).toBe(configuredDbPath);
      expect(backupBundle.storage.db_base64.length).toBeGreaterThan(0);

      const exportPath = join(dataDir, "configured-export.json");
      const exportResult = await dispatchCli(runtime, ["export", "--output", exportPath, "--json"]);
      const exportBundle = await readOperationBundle(exportPath);
      expect(exportResult.exitCode).toBe(0);
      expect(exportBundle.storage.db_path).toBe(configuredDbPath);
      expect(exportBundle.storage.db_base64.length).toBeGreaterThan(0);
    } finally {
      await client.close();
      await server.close();
      await runtime.shutdown();
    }
  }, RELEASE_LOOP_TIMEOUT_MS);
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

async function seedReleaseFixture(dataDir: string): Promise<void> {
  await seedReleaseFixtureAtDbPath(join(dataDir, "alaya.db"));
}

async function seedReleaseFixtureAtDbPath(dbPath: string): Promise<void> {
  const database = initDatabase({ filename: dbPath });
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
      title: "P5 release loop run",
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

async function readMemoryEntry(dataDir: string, objectId: string): Promise<Readonly<MemoryEntry> | null> {
  const database = initDatabase({ filename: join(dataDir, "alaya.db") });
  const memoryRepo = new SqliteMemoryEntryRepo(database);
  return await memoryRepo.findById(objectId);
}

async function readReleaseEvidence(
  dataDir: string,
  ids: Readonly<{
    deliveryId: string;
    objectId: string;
    proposalId: string;
    signalId: string;
  }>
): Promise<
  Readonly<{
    memory: Readonly<MemoryEntry> | null;
    proposal: unknown;
    signal: unknown;
    delivery: unknown;
    usages: readonly unknown[];
    summary: Readonly<Record<string, unknown>>;
  }>
> {
  const database = initDatabase({ filename: join(dataDir, "alaya.db") });
  const memoryRepo = new SqliteMemoryEntryRepo(database);
  const proposalRepo = new SqliteProposalRepo(database);
  const signalRepo = new SqliteSignalRepo(database);
  const trustStateRepo = new SqliteTrustStateRepo(database);
  const [memory, proposal, signal, delivery, usages] = await Promise.all([
    memoryRepo.findById(ids.objectId),
    proposalRepo.findById(ids.proposalId),
    signalRepo.getById(ids.signalId),
    trustStateRepo.findDeliveryById(ids.deliveryId),
    trustStateRepo.listUsageByDeliveryIds([ids.deliveryId])
  ]);

  return {
    memory,
    proposal,
    signal,
    delivery,
    usages,
    summary: {
      memory_content: memory?.content,
      proposal_state:
        proposal === null ? null : (proposal as { readonly resolution_state?: unknown }).resolution_state,
      signal_state: signal === null ? null : (signal as { readonly signal_state?: unknown }).signal_state,
      delivery_id: delivery === null ? null : ids.deliveryId,
      usage_count: usages.length
    }
  };
}

async function readGardenEvidence(dataDir: string): Promise<
  Readonly<{
    dispatched_events: number;
    completed_events: number;
    health_journal_entries: number;
  }>
> {
  const database = initDatabase({ filename: join(dataDir, "alaya.db") });
  const eventLogRepo = new SqliteEventLogRepo(database);
  const healthJournalRepo = new SqliteHealthJournalRepo(database);
  const [dispatched, completed, healthEntries] = await Promise.all([
    eventLogRepo.queryByType(Phase4AEventType.SOUL_GARDEN_TASK_DISPATCHED),
    eventLogRepo.queryByType(Phase4AEventType.SOUL_GARDEN_TASK_COMPLETED),
    healthJournalRepo.findByWorkspace("workspace-1", {
      kind: HealthEventKind.GARDEN_BACKLOG,
      limit: 10
    })
  ]);

  return {
    dispatched_events: dispatched.length,
    completed_events: completed.length,
    health_journal_entries: healthEntries.length
  };
}

async function readOperationBundle(path: string): Promise<
  Readonly<{
    kind: "backup" | "export";
    storage: Readonly<{ db_path: string | null; db_base64: string }>;
  }>
> {
  return JSON.parse(await readFile(path, "utf8")) as {
    kind: "backup" | "export";
    storage: { db_path: string | null; db_base64: string };
  };
}

function createMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-05-02T00:00:00.000Z",
    updated_at: "2026-05-02T00:00:00.000Z",
    created_by: "p5-release-loop",
    dimension: MemoryDimension.PREFERENCE,
    source_kind: SourceKind.USER,
    formation_kind: FormationKind.EXPLICIT,
    scope_class: ScopeClass.PROJECT,
    content: "Use pnpm for all workspace commands.",
    domain_tags: ["tooling", "workflow"],
    evidence_refs: ["p5-release-loop"],
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
  const directory = await mkdtemp(join(tmpdir(), "alaya-p5-release-loop-"));
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
}
