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
  SqliteMemoryEntryRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo
} from "@do-soul/alaya-storage";
import { createAlayaCliBridge } from "../cli/bridge.js";
import { registerAlayaCliCommands } from "../cli/register.js";
import { createAlayaDaemonRuntime, type AlayaDaemonRuntime } from "../index.js";

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

afterEach(async () => {
  restoreDataDir();

  for (const directory of tempDirs.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("trust state SQL persistence", () => {
  it("persists delivered and used counts across daemon restart after runtime recall and usage proof", async () => {
    const dataDir = await createTempDataDir();
    const databasePath = join(dataDir, "alaya.db");
    setDataDir(dataDir);
    await seedRecallFixture(dataDir);

    const firstRuntime = await createAlayaDaemonRuntime();
    let firstStatus: TrustSummary | null = null;

    try {
      const recall = await callRuntimeMemoryTool<SoulMemorySearchResponse>(
        firstRuntime,
        "soul.recall",
        {
          query: "Use pnpm for all workspace commands.",
          scope_class: ScopeClass.PROJECT,
          dimension: MemoryDimension.PREFERENCE,
          domain_tags: null,
          max_results: 3
        }
      );
      expect(recall.results.map((result) => result.object_id)).toEqual([
        "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca"
      ]);

      await callRuntimeMemoryTool(firstRuntime, "soul.report_context_usage", {
        delivery_id: recall.delivery_id,
        usage_state: "used",
        used_object_ids: ["70a0b18b-5f8b-4fd2-a1b0-97ce48113fca"],
        reason: "Used the recalled pnpm preference."
      });

      firstStatus = await readCodexStatus(firstRuntime);
      expect(firstStatus).toMatchObject({
        agent_target: "codex",
        delivered_count: 1,
        used_count: 1,
        skipped_count: 0,
        not_applicable_count: 0
      });
    } finally {
      await firstRuntime.shutdown();
    }

    expect(existsSync(databasePath)).toBe(true);
    expect(process.env.DATA_DIR).toBe(dataDir);
    expect(readMaxSchemaVersion(dataDir)).toBe(64);
    expect(firstStatus).not.toBeNull();
    if (firstStatus === null) {
      throw new Error("first daemon lifetime did not produce a trust status");
    }

    const secondRuntime = await createAlayaDaemonRuntime();
    try {
      const restartedStatus = await readCodexStatus(secondRuntime);

      expect(restartedStatus).toMatchObject({
        agent_target: "codex",
        delivered_count: firstStatus.delivered_count,
        used_count: firstStatus.used_count,
        skipped_count: firstStatus.skipped_count,
        not_applicable_count: firstStatus.not_applicable_count
      });
      expect(restartedStatus.last_delivery_at).toBe(firstStatus.last_delivery_at);
      expect(restartedStatus.last_usage_report_at).toBe(firstStatus.last_usage_report_at);
    } finally {
      await secondRuntime.shutdown();
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("rolls back duplicate delivery and usage audit events when SQL persistence rejects the mutation", async () => {
    const dataDir = await createTempDataDir();
    setDataDir(dataDir);

    const runtime = await createAlayaDaemonRuntime();
    try {
      await runtime.services.trustStateRecorder.recordDelivery({
        delivery_id: "delivery-duplicate",
        agent_target: "codex",
        workspace_id: "workspace-1",
        run_id: "run-1",
        delivered_object_ids: ["memory-1"],
        delivered_at: "2026-05-01T00:00:00.000Z"
      });
      await expect(
        runtime.services.trustStateRecorder.recordDelivery({
          delivery_id: "delivery-duplicate",
          agent_target: "codex",
          workspace_id: "workspace-1",
          run_id: "run-1",
          delivered_object_ids: ["memory-2"],
          delivered_at: "2026-05-01T00:01:00.000Z"
        })
      ).rejects.toMatchObject({ code: "CONFLICT" });

      await runtime.services.trustStateRecorder.recordUsage({
        delivery_id: "delivery-duplicate",
        usage_state: "used",
        used_object_ids: ["memory-1"],
        reason: "first report",
        reported_at: "2026-05-01T00:02:00.000Z"
      });
      await expect(
        runtime.services.trustStateRecorder.recordUsage({
          delivery_id: "delivery-duplicate",
          usage_state: "skipped",
          used_object_ids: [],
          reason: "replacement report",
          reported_at: "2026-05-01T00:03:00.000Z"
        })
      ).rejects.toMatchObject({ code: "CONFLICT" });
    } finally {
      await runtime.shutdown();
    }

    const database = initDatabase({ filename: join(dataDir, "alaya.db") });
    try {
      const deliveryRows = database.connection
        .prepare("SELECT delivery_id, audit_event_id FROM trust_context_delivery WHERE delivery_id = ?")
        .all("delivery-duplicate") as AuditLinkRow[];
      const usageRows = database.connection
        .prepare("SELECT delivery_id, audit_event_id FROM trust_usage_proof WHERE delivery_id = ?")
        .all("delivery-duplicate") as AuditLinkRow[];
      const deliveryEvents = database.connection
        .prepare("SELECT event_id FROM event_log WHERE entity_type = ? AND entity_id = ? ORDER BY rowid ASC")
        .all("trust_context_delivery", "delivery-duplicate") as EventIdRow[];
      const usageEvents = database.connection
        .prepare("SELECT event_id FROM event_log WHERE entity_type = ? AND entity_id = ? ORDER BY rowid ASC")
        .all("trust_usage_proof", "delivery-duplicate") as EventIdRow[];

      expect(deliveryRows).toHaveLength(1);
      expect(usageRows).toHaveLength(1);
      expect(deliveryEvents).toHaveLength(1);
      expect(usageEvents).toHaveLength(1);
      expect(deliveryRows[0]).toMatchObject({ audit_event_id: deliveryEvents[0]?.event_id });
      expect(usageRows[0]).toMatchObject({ audit_event_id: usageEvents[0]?.event_id });
    } finally {
      database.close();
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);

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

function readMaxSchemaVersion(dataDir: string): number {
  const database = initDatabase({ filename: join(dataDir, "alaya.db") });
  try {
    const row = database.connection.prepare("SELECT MAX(version) AS version FROM schema_version").get() as {
      readonly version: number;
    };
    return row.version;
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
