import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  RecallContextEventType,
  StorageTier,
  type TrustSummary
} from "@do-soul/alaya-protocol";
import {
  initDatabase,
  createGardenBackgroundDataPorts,
  getCurrentSchemaSummary,
  SqliteMemoryEntryRepo,
  SqliteEventLogRepo
} from "@do-soul/alaya-storage";
import { createAlayaCliBridge } from "../../cli/bridge.js";
import { registerAlayaCliCommands } from "../../cli/register.js";
import { createAlayaDaemonRuntime } from "../../index.js";
import {
  INTEGRATION_TEST_TIMEOUT_MS,
  callRuntimeMemoryTool,
  createMemoryEntry,
  createTempDataDir,
  readCodexStatus,
  readSchemaSummary,
  seedRecallFixture,
  seedCrossWorkspaceFixture,
  setDataDir,
  restoreDataDir,
  type AuditLinkRow,
  type EventIdRow
} from "./state-persistence-fixture.js";

describe("trust state SQL persistence", () => {

  it("persists bound delivery and usage telemetry across daemon restart", async () => {
    const dataDir = await createTempDataDir();
    const databasePath = join(dataDir, "alaya.db");
    setDataDir(dataDir);
    await seedRecallFixture(dataDir);

    const firstRuntime = await createAlayaDaemonRuntime();
    let firstStatus: TrustSummary | null = null;

    try {
      await firstRuntime.services.trustStateRecorder.recordDelivery({
        delivery_id: "delivery-persistence",
        agent_target: "codex",
        workspace_id: "workspace-1",
        run_id: "run-1",
        delivered_object_ids: ["70a0b18b-5f8b-4fd2-a1b0-97ce48113fca"],
        delivered_at: "2026-05-01T00:00:00.000Z"
      });

      await callRuntimeMemoryTool(firstRuntime, "soul.report_context_usage", {
        delivery_id: "delivery-persistence",
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
    const schemaSummary = readSchemaSummary(dataDir);
    expect(schemaSummary.schemaOk).toBe(true);
    expect(schemaSummary.persistedMaxVersion).toBe(schemaSummary.knownMaxVersion);
    expect(firstStatus).not.toBeNull();
    if (firstStatus === null) {
      throw new Error("first daemon lifetime did not produce a trust status");
    }

    const telemetryDatabase = initDatabase({ filename: databasePath });
    try {
      const telemetryEvents = (await new SqliteEventLogRepo(telemetryDatabase).queryByType(
        RecallContextEventType.SOUL_CONTEXT_USAGE_REPORTED
      )).events;
      expect(telemetryEvents).toHaveLength(1);
      expect(telemetryEvents[0]).toMatchObject({
        workspace_id: "workspace-1",
        run_id: "run-1",
        caused_by: "codex"
      });
    } finally {
      telemetryDatabase.close();
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

  it("records cold-memory usage without mutating memory or Janitor eligibility", async () => {
    const dataDir = await createTempDataDir();
    const databasePath = join(dataDir, "alaya.db");
    setDataDir(dataDir);
    await seedRecallFixture(
      dataDir,
      createMemoryEntry({
        storage_tier: StorageTier.COLD,
        activation_score: 0.1,
        last_used_at: "2026-04-01T00:00:00.000Z",
        last_hit_at: "2026-04-01T00:00:00.000Z"
      })
    );

    const runtime = await createAlayaDaemonRuntime();
    try {
      await runtime.services.trustStateRecorder.recordDelivery({
        delivery_id: "delivery-cold-reported-used",
        agent_target: "codex",
        workspace_id: "workspace-1",
        run_id: "run-1",
        delivered_object_ids: ["70a0b18b-5f8b-4fd2-a1b0-97ce48113fca"],
        delivered_at: "2026-05-01T00:00:00.000Z"
      });

      await callRuntimeMemoryTool(runtime, "soul.report_context_usage", {
        delivery_id: "delivery-cold-reported-used",
        usage_state: "used",
        used_object_ids: ["70a0b18b-5f8b-4fd2-a1b0-97ce48113fca"],
        reason: "Used the recalled low-activation memory."
      });

      const database = initDatabase({ filename: databasePath });
      const memoryRepo = new SqliteMemoryEntryRepo(database);
      const updated = await memoryRepo.findById("70a0b18b-5f8b-4fd2-a1b0-97ce48113fca");
      expect(updated).toMatchObject({
        storage_tier: StorageTier.COLD,
        activation_score: 0.1,
        workspace_id: "workspace-1",
        last_used_at: "2026-04-01T00:00:00.000Z",
        last_hit_at: "2026-04-01T00:00:00.000Z"
      });

      const ports = createGardenBackgroundDataPorts(database, {
        now: () => "2026-05-01T00:00:00.000Z"
      });
      await expect(
        ports.tieringPort.findHotDemotionCandidates("workspace-1", {
          maxLastHitAgeMs: 7 * 24 * 60 * 60 * 1000,
          minActivationScore: 0.5
        })
      ).resolves.toEqual([]);
    } finally {
      await runtime.shutdown();
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("does not refresh a delivered object id owned by a different workspace", async () => {
    const dataDir = await createTempDataDir();
    const databasePath = join(dataDir, "alaya.db");
    setDataDir(dataDir);
    await seedCrossWorkspaceFixture(dataDir);

    const runtime = await createAlayaDaemonRuntime();
    try {
      await runtime.services.trustStateRecorder.recordDelivery({
        delivery_id: "delivery-foreign-memory",
        agent_target: "codex",
        workspace_id: "workspace-1",
        run_id: "run-1",
        delivered_object_ids: ["11111111-1111-4111-8111-111111111111"],
        delivered_at: "2026-05-01T00:00:00.000Z"
      });

      const result = await runtime.services.mcpMemoryToolHandler.call({
        toolName: "soul.report_context_usage",
        arguments: {
          delivery_id: "delivery-foreign-memory",
          usage_state: "used",
          used_object_ids: ["11111111-1111-4111-8111-111111111111"],
          reason: "spoofed foreign memory"
        },
        context: {
          workspaceId: "workspace-1",
          runId: "run-1",
          agentTarget: "codex",
          sessionId: "trust-state-cross-workspace-test"
        }
      });

      expect(result).toMatchObject({
        ok: false,
        error: { code: "NOT_FOUND" }
      });

      const database = initDatabase({ filename: databasePath });
      const memoryRepo = new SqliteMemoryEntryRepo(database);
      await expect(memoryRepo.findById("11111111-1111-4111-8111-111111111111")).resolves.toMatchObject({
        workspace_id: "workspace-2",
        storage_tier: StorageTier.COLD,
        last_used_at: "2026-04-01T00:00:00.000Z",
        last_hit_at: "2026-04-01T00:00:00.000Z"
      });
      const usageRows = database.connection
        .prepare("SELECT delivery_id FROM trust_usage_proof WHERE delivery_id = ?")
        .all("delivery-foreign-memory");
      const usageEvents = database.connection
        .prepare("SELECT event_id FROM event_log WHERE entity_type = ? AND entity_id = ?")
        .all("trust_usage_proof", "delivery-foreign-memory");
      expect(usageRows).toEqual([]);
      expect(usageEvents).toEqual([]);
    } finally {
      await runtime.shutdown();
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
