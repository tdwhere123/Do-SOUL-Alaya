import { describe, expect, it } from "vitest";
import { FieldGenerationEventType, type CausalUsagePort } from "@do-soul/alaya-protocol";
import { EventPublisher, fieldContractSha256 } from "@do-soul/alaya-core";
import {
  initDatabase,
  SqliteEventLogRepo,
  SqliteFieldCausalUsageRepo
} from "@do-soul/alaya-storage";
import {
  recordCausalUsedReceipts
} from "../../../mcp-memory/usage/causal-usage-recorder.js";
import { createSqliteCausalUsagePort } from "../../../runtime/field/sqlite-causal-usage-port.js";

const FIRST = "2026-08-16T00:00:00.000Z";
const REPLAY = "2026-08-17T00:00:00.000Z";

describe("causal usage recorder", () => {
  it("persists and audits once, then replays the canonical occurred_at", async () => {
    const harness = createHarness();
    try {
      const first = await recordCausalUsedReceipts(harness.usagePort, input(harness, FIRST));
      const replay = await recordCausalUsedReceipts(harness.usagePort, input(harness, REPLAY));

      expect(first[0]?.occurred_at).toBe(FIRST);
      expect(replay[0]?.occurred_at).toBe(FIRST);
      expect(await usageAudits(harness.eventLogRepo, first[0]!.identity)).toHaveLength(1);
    } finally {
      harness.database.close();
    }
  });

  it("rolls back both receipt and audit when the persist-first transaction crashes", async () => {
    const harness = createHarness();
    const failAfterPersist: CausalUsagePort = {
      recordUsage(receipt) {
        harness.usagePort.recordUsage(receipt);
        throw new Error("simulated crash");
      }
    };
    try {
      await expect(recordCausalUsedReceipts(failAfterPersist, input(harness, FIRST)))
        .rejects.toThrow("simulated crash");
      expect(harness.database.connection.prepare(
        "SELECT COUNT(*) AS count FROM causal_usage_receipts"
      ).get()).toEqual({ count: 0 });

      const retried = await recordCausalUsedReceipts(harness.usagePort, input(harness, REPLAY));
      expect(retried[0]?.occurred_at).toBe(REPLAY);
      expect(await usageAudits(harness.eventLogRepo, retried[0]!.identity)).toHaveLength(1);
    } finally {
      harness.database.close();
    }
  });

  it("records one receipt per delivered object for the same confirm event", async () => {
    const harness = createHarness();
    try {
      const receipts = await recordCausalUsedReceipts(
        harness.usagePort,
        input(harness, FIRST, ["memory-1", "memory-2"])
      );

      expect(receipts.map((receipt) => receipt.downstream_ref)).toEqual(["memory-1", "memory-2"]);
      expect(new Set(receipts.map((receipt) => receipt.identity)).size).toBe(2);
      expect(harness.database.connection.prepare(
        "SELECT COUNT(*) AS count FROM causal_usage_receipts"
      ).get()).toEqual({ count: 2 });
      expect(await usageAudits(harness.eventLogRepo, receipts[0]!.identity)).toHaveLength(1);
      expect(await usageAudits(harness.eventLogRepo, receipts[1]!.identity)).toHaveLength(1);
    } finally {
      harness.database.close();
    }
  });
});

function createHarness() {
  const database = initDatabase({ filename: ":memory:" });
  seedWorkspace(database);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const eventPublisher = new EventPublisher({
    eventLogRepo,
    runHotStateService: { apply: () => undefined },
    runtimeNotifier: { notify: () => undefined, notifyEntry: () => undefined }
  });
  const usagePort = createSqliteCausalUsagePort({
    repo: new SqliteFieldCausalUsageRepo(database, fieldContractSha256),
    sha256: fieldContractSha256
  });
  return { database, eventLogRepo, eventPublisher, usagePort };
}

function input(
  harness: ReturnType<typeof createHarness>,
  occurredAt: string,
  usedObjectIds: readonly string[] = ["memory-1"]
) {
  return {
    workspaceId: "workspace-1",
    causalKey: "resolution-event-1",
    usedObjectIds,
    occurredAt,
    scope: "workspace-1",
    eventPublisher: harness.eventPublisher,
    runId: "run-1",
    causedBy: "agent-1"
  } as const;
}

async function usageAudits(eventLogRepo: SqliteEventLogRepo, identity: string) {
  return (await eventLogRepo.queryByEntity("causal_usage", identity))
    .filter((entry) =>
      entry.event_type === FieldGenerationEventType.SOUL_FIELD_USAGE_CAUSAL_RECORDED
    );
}

function seedWorkspace(database: ReturnType<typeof initDatabase>): void {
  database.connection.prepare(`
    INSERT INTO workspaces (
      workspace_id, name, root_path, workspace_kind, default_engine_binding,
      workspace_state, created_at, archived_at, default_engine_class
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "workspace-1", "Workspace", "/tmp/workspace-1", "local_repo", null,
    "active", FIRST, null, null
  );
}
