import { existsSync } from "node:fs";

import { mkdtemp, rm } from "node:fs/promises";

import { tmpdir } from "node:os";

import { join } from "node:path";

import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import {
  FormationKind,
  MemoryDimension,
  RunMode,
  RunState,
  ScopeClass,
  SourceKind,
  StorageTier,
  WorkspaceKind,
  WorkspaceState,
  type MemoryEntry,
  type SoulMemorySearchResponse,
  type TrustSummary
} from "@do-soul/alaya-protocol";

import {
  initDatabase,
  createGardenBackgroundDataPorts,
  getCurrentSchemaSummary,
  SqliteMemoryEntryRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo
} from "@do-soul/alaya-storage";

import { createAlayaCliBridge } from "../../cli/bridge.js";

import { registerAlayaCliCommands } from "../../cli/register.js";

import { createAlayaDaemonRuntime, type AlayaDaemonRuntime } from "../../index.js";

const tempDirs: string[] = [];

const originalDataDir = process.env.DATA_DIR;

const originalAlayaConfigDir = process.env.ALAYA_CONFIG_DIR;

const INTEGRATION_TEST_TIMEOUT_MS = 30_000;

interface AuditLinkRow {
  readonly delivery_id: string;
  readonly audit_event_id: string;
}

interface EventIdRow {
  readonly event_id: string;
}

async function callRuntimeMemoryTool<TOutput = unknown>(
  runtime: AlayaDaemonRuntime,
  toolName: string,
  args: unknown
): Promise<TOutput> {
  const result = await runtime.services.mcpMemoryToolHandler.call({
    toolName,
    arguments: args,
    context: {
      workspaceId: "workspace-1",
      runId: "run-1",
      agentTarget: "codex",
      sessionId: "trust-state-persistence-test-session",
      surfaceId: "gate4-proof"
    }
  });

  expect(result).toMatchObject({ ok: true, tool_name: toolName });
  if (!result.ok) {
    throw new Error(result.error.message);
  }

  return result.output as TOutput;
}

async function readCodexStatus(runtime: AlayaDaemonRuntime): Promise<TrustSummary> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const bridge = createAlayaCliBridge(runtime, {
    stdin: new PassThrough(),
    stdout,
    stderr,
    isTTY: false
  });
  registerAlayaCliCommands(bridge, runtime);

  const result = await bridge.dispatch(["status", "--agent", "codex", "--json"]);
  expect(result.exitCode).toBe(0);

  const report = result.json as {
    readonly trust: readonly TrustSummary[];
  };
  const summary = report.trust.find((candidate) => candidate.agent_target === "codex");
  expect(summary).toBeDefined();
  return summary!;
}

async function seedRecallFixture(dataDir: string, memory: MemoryEntry = createMemoryEntry()): Promise<void> {
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
    await memoryRepo.create(memory);
  } finally {
    database.close();
  }
}

async function seedCrossWorkspaceFixture(dataDir: string): Promise<void> {
  const database = initDatabase({ filename: join(dataDir, "alaya.db") });
  try {
    const workspaceRepo = new SqliteWorkspaceRepo(database);
    const runRepo = new SqliteRunRepo(database);
    const memoryRepo = new SqliteMemoryEntryRepo(database);

    for (const workspaceId of ["workspace-1", "workspace-2"]) {
      await workspaceRepo.create({
        workspace_id: workspaceId,
        name: workspaceId,
        root_path: `/tmp/alaya-${workspaceId}`,
        workspace_kind: WorkspaceKind.LOCAL_REPO,
        default_engine_binding: null,
        workspace_state: WorkspaceState.ACTIVE
      });
      await runRepo.create({
        run_id: workspaceId === "workspace-1" ? "run-1" : "run-2",
        workspace_id: workspaceId,
        title: `${workspaceId} run`,
        goal: null,
        run_mode: RunMode.CHAT,
        engine_binding_id: null,
        engine_class: null,
        run_state: RunState.IDLE,
        current_surface_id: null
      });
    }

    await memoryRepo.create(createMemoryEntry({
      object_id: "11111111-1111-4111-8111-111111111111",
      workspace_id: "workspace-2",
      run_id: "run-2",
      storage_tier: StorageTier.COLD,
      activation_score: 0.1,
      last_used_at: "2026-04-01T00:00:00.000Z",
      last_hit_at: "2026-04-01T00:00:00.000Z"
    }));
  } finally {
    database.close();
  }
}

function readSchemaSummary(dataDir: string): ReturnType<typeof getCurrentSchemaSummary> {
  const database = initDatabase({ filename: join(dataDir, "alaya.db") });
  try {
    return getCurrentSchemaSummary(database);
  } finally {
    database.close();
  }
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
  const directory = await mkdtemp(join(tmpdir(), "alaya-trust-state-"));
  tempDirs.push(directory);
  return directory;
}

function setDataDir(dataDir: string): void {
  process.env.DATA_DIR = dataDir;
  // Override ALAYA_CONFIG_DIR so any user-installed alaya.toml on the
  // host machine cannot leak through resolveConfiguredDatabasePath
  // (which prefers TOML db_path over DATA_DIR).
  process.env.ALAYA_CONFIG_DIR = dataDir;
}

function restoreDataDir(): void {
  if (originalDataDir === undefined) {
    delete process.env.DATA_DIR;
  } else {
    process.env.DATA_DIR = originalDataDir;
  }

  if (originalAlayaConfigDir === undefined) {
    delete process.env.ALAYA_CONFIG_DIR;
    return;
  }

  process.env.ALAYA_CONFIG_DIR = originalAlayaConfigDir;
}

afterEach(async () => {
  restoreDataDir();

  for (const directory of tempDirs.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("trust state SQL persistence", () => {

  it("rebuilds installed configured and unverifiable counters from EventLog across restart", async () => {
    const dataDir = await createTempDataDir();
    setDataDir(dataDir);

    const firstRuntime = await createAlayaDaemonRuntime();
    try {
      await firstRuntime.services.trustStateRecorder.recordInstalled("codex");
      await firstRuntime.services.trustStateRecorder.recordConfigured("codex");
      await firstRuntime.services.trustStateRecorder.recordDelivery({
        delivery_id: "delivery-counter-reset",
        agent_target: "codex",
        workspace_id: "workspace-1",
        run_id: "run-1",
        delivered_object_ids: ["memory-1"],
        delivered_at: "2026-05-01T01:00:00.000Z"
      });
      await firstRuntime.services.trustStateRecorder.recordUnverifiable("codex", "session-1");

      await expect(firstRuntime.services.trustStateRecorder.summarize("codex")).resolves.toMatchObject({
        delivered_count: 1,
        installed_count: 1,
        configured_count: 1,
        unverifiable_count: 1
      });
    } finally {
      await firstRuntime.shutdown();
    }

    const secondRuntime = await createAlayaDaemonRuntime();
    try {
      await expect(secondRuntime.services.trustStateRecorder.summarize("codex")).resolves.toMatchObject({
        delivered_count: 1,
        installed_count: 1,
        configured_count: 1,
        unverifiable_count: 1
      });
    } finally {
      await secondRuntime.shutdown();
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
