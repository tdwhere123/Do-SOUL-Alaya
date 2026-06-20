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
  GardenEventType,
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
  type Proposal,
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

import { ALAYA_MEMORY_TOOL_NAMES } from "../../mcp-memory/tool-catalog.js";

import { createAlayaCliBridge } from "../../cli/bridge.js";

import { registerAlayaCliCommands } from "../../cli/register.js";

import { createAlayaDaemonRuntime, type AlayaDaemonRuntime } from "../../index.js";

import { createAlayaMcpServer } from "../../mcp/mcp-server.js";

export const PRIMARY_MEMORY_ID = "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca";

export const FOREIGN_MEMORY_ID = "8b6718fc-5d1f-4a1a-9a67-f6509fa6b8b3";

export const FOREIGN_PROPOSAL_ID = "44bce795-d51c-49e8-8e60-22195c98b6ab";

export const tempDirs: string[] = [];

export const originalDataDir = process.env.DATA_DIR;

export const originalOpenAiApiKey = process.env.OPENAI_API_KEY;

export const originalAlayaOpenAiSecretRef = process.env.ALAYA_OPENAI_SECRET_REF;

export const originalEmbeddingSupplementOptIn = process.env.ALAYA_ENABLE_EMBEDDING_SUPPLEMENT;

export const originalAlayaConfigDir = process.env.ALAYA_CONFIG_DIR;

export const originalCodexHome = process.env.CODEX_HOME;

export const originalHome = process.env.HOME;

export const originalReviewerIdentity = process.env.ALAYA_REVIEWER_IDENTITY;

export const originalReviewerToken = process.env.ALAYA_REVIEWER_TOKEN;

export const RELEASE_LOOP_TIMEOUT_MS = 45_000;

export async function callTool<TOutput>(
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

export async function dispatchCli(
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

export async function seedReleaseFixture(dataDir: string): Promise<void> {
  await seedReleaseFixtureAtDbPath(join(dataDir, "alaya.db"));
}

export async function seedReleaseFixtureAtDbPath(dbPath: string): Promise<void> {
  const database = initDatabase({ filename: dbPath });
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
      title: "P5 release loop run",
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
      title: "P5 release loop foreign run",
      goal: null,
      run_mode: RunMode.CHAT,
      engine_binding_id: null,
      engine_class: null,
      run_state: RunState.IDLE,
      current_surface_id: null
    });
    await memoryRepo.create(
      createMemoryEntry({
        object_id: FOREIGN_MEMORY_ID,
        content: "Foreign workspace memory must not be opened from workspace one.",
        workspace_id: "workspace-2",
        run_id: "run-2"
      })
    );
    await proposalRepo.create({
      proposal: createProposal(),
      workspace_id: "workspace-2",
      run_id: "run-2",
      target_object_kind: "memory_entry"
    });
  } finally {
    database.close();
  }
}

export async function readMemoryEntry(dataDir: string, objectId: string): Promise<Readonly<MemoryEntry> | null> {
  const database = initDatabase({ filename: join(dataDir, "alaya.db") });
  const memoryRepo = new SqliteMemoryEntryRepo(database);
  return await memoryRepo.findById(objectId);
}

export async function readReleaseEvidence(
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

export async function readGardenEvidence(dataDir: string): Promise<
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
    health_journal_entries: healthEntries.length
  };
}

export async function readOperationBundle(path: string): Promise<
  Readonly<{
    kind: "backup" | "export";
    config: Readonly<{ alaya_toml: string | null; env_file: string | null }>;
    storage: Readonly<{ db_path: string | null; db_base64: string }>;
  }>
> {
  return JSON.parse(await readFile(path, "utf8")) as {
    kind: "backup" | "export";
    config: { alaya_toml: string | null; env_file: string | null };
    storage: { db_path: string | null; db_base64: string };
  };
}

export function createMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: PRIMARY_MEMORY_ID,
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

export function createProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    runtime_id: FOREIGN_PROPOSAL_ID,
    object_kind: "proposal",
    task_surface_ref: null,
    expires_at: null,
    derived_from: FOREIGN_MEMORY_ID,
    retention_policy: "session_only",
    proposal_id: FOREIGN_PROPOSAL_ID,
    dossier_ref: null,
    recommended_option_id: null,
    proposal_options: [
      {
        option_id: `memory_update_${FOREIGN_PROPOSAL_ID}`,
        option_kind: "request_confirmation",
        preserves_protected_constraints: true,
        dropped_candidates: [],
        unresolved_after_apply: [],
        requires_confirmation: true
      }
    ],
    resolution_state: ProposalResolutionState.PENDING,
    last_updated_at: "2026-05-02T00:00:00.000Z",
    ...overrides
  };
}

export async function createTempDataDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "alaya-p5-release-loop-"));
  tempDirs.push(directory);
  return directory;
}

export function restoreProcessEnv(): void {
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

afterEach(async () => {
  restoreProcessEnv();

  for (const directory of tempDirs.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});
