import { afterEach, describe, expect, it } from "vitest";
import { initDatabase } from "../db.js";
import { SqliteTrustStateRepo } from "../repos/trust-state-repo.js";

const databases = new Set<ReturnType<typeof initDatabase>>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
});

describe("SqliteTrustStateRepo", () => {
  it("persists and reloads context deliveries and usage proofs", async () => {
    const repo = createRepo();

    await repo.createDelivery({
      delivery_id: "delivery-1",
      agent_target: "codex",
      workspace_id: "workspace-1",
      run_id: "run-1",
      delivered_object_ids: ["memory-1", "memory-2"],
      delivered_at: "2026-04-30T10:00:00.000Z",
      audit_event_id: "event-delivery-1"
    });
    await repo.createUsage({
      delivery_id: "delivery-1",
      usage_state: "used",
      used_object_ids: ["memory-1"],
      reason: "cited",
      reported_at: "2026-04-30T10:01:00.000Z",
      audit_event_id: "event-usage-1"
    });

    await expect(repo.findDeliveryById("delivery-1")).resolves.toMatchObject({
      delivery_id: "delivery-1",
      delivered_object_ids: ["memory-1", "memory-2"]
    });
    await expect(repo.listDeliveriesByAgentTarget("codex")).resolves.toHaveLength(1);
    await expect(repo.listUsageByDeliveryIds(["delivery-1"])).resolves.toEqual([
      {
        delivery_id: "delivery-1",
        usage_state: "used",
        used_object_ids: ["memory-1"],
        reason: "cited",
        reported_at: "2026-04-30T10:01:00.000Z",
        audit_event_id: "event-usage-1"
      }
    ]);
  });

  it("persists delivered object identities while preserving legacy id projection", async () => {
    const repo = createRepo();

    await repo.createDelivery({
      delivery_id: "delivery-identities",
      agent_target: "codex",
      workspace_id: "workspace-1",
      run_id: "run-1",
      delivered_object_ids: ["shared-object"],
      delivered_objects: [
        { object_id: "shared-object", object_kind: "synthesis_capsule" },
        { object_id: "shared-object", object_kind: "memory_entry" }
      ],
      delivered_at: "2026-04-30T10:00:00.000Z",
      audit_event_id: "event-delivery-identities"
    });

    await expect(repo.findDeliveryById("delivery-identities")).resolves.toMatchObject({
      delivered_object_ids: ["shared-object"],
      delivered_objects: [
        { object_id: "shared-object", object_kind: "synthesis_capsule" },
        { object_id: "shared-object", object_kind: "memory_entry" }
      ]
    });
  });

  it("persists and reloads per-anchor usage proof signals", async () => {
    const repo = createRepo();

    await repo.createDelivery({
      delivery_id: "delivery-directional",
      agent_target: "codex",
      workspace_id: "workspace-1",
      run_id: "run-1",
      delivered_object_ids: ["memory-source", "memory-target"],
      delivered_at: "2026-04-30T10:00:00.000Z",
      audit_event_id: "event-delivery-directional"
    });
    await repo.createUsage({
      delivery_id: "delivery-directional",
      usage_state: "used",
      used_object_ids: ["memory-target"],
      per_anchor_usage: [{ object_id: "memory-target", anchor_role: "target" }],
      trust_mode: "automatic",
      reason: "target anchor cited",
      reported_at: "2026-04-30T10:01:00.000Z",
      audit_event_id: "event-usage-directional"
    });

    await expect(repo.listUsageByDeliveryIds(["delivery-directional"])).resolves.toEqual([
      {
        delivery_id: "delivery-directional",
        usage_state: "used",
        used_object_ids: ["memory-target"],
        per_anchor_usage: [{ object_id: "memory-target", anchor_role: "target" }],
        trust_mode: "automatic",
        reason: "target anchor cited",
        reported_at: "2026-04-30T10:01:00.000Z",
        audit_event_id: "event-usage-directional"
      }
    ]);
  });

  it("rejects duplicate delivery_id without replacing the original audit_event_id", async () => {
    const repo = createRepo();

    await repo.createDelivery({
      delivery_id: "delivery-duplicate",
      agent_target: "codex",
      workspace_id: "workspace-1",
      run_id: "run-1",
      delivered_object_ids: ["memory-1"],
      delivered_at: "2026-04-30T10:00:00.000Z",
      audit_event_id: "event-delivery-original"
    });

    expect(() =>
      repo.createDelivery({
        delivery_id: "delivery-duplicate",
        agent_target: "codex",
        workspace_id: "workspace-1",
        run_id: "run-1",
        delivered_object_ids: ["memory-2"],
        delivered_at: "2026-04-30T10:02:00.000Z",
        audit_event_id: "event-delivery-replacement"
      })
    ).toThrowError(expect.objectContaining({
      code: "CONFLICT",
      message: "Trust delivery delivery-duplicate already exists."
    }));

    await expect(repo.findDeliveryById("delivery-duplicate")).resolves.toMatchObject({
      delivery_id: "delivery-duplicate",
      delivered_object_ids: ["memory-1"],
      audit_event_id: "event-delivery-original"
    });
  });

  it("rejects duplicate delivery audit_event_id with a distinct conflict message", async () => {
    const repo = createRepo();

    await repo.createDelivery({
      delivery_id: "delivery-audit-original",
      agent_target: "codex",
      workspace_id: "workspace-1",
      run_id: "run-1",
      delivered_object_ids: ["memory-1"],
      delivered_at: "2026-04-30T10:00:00.000Z",
      audit_event_id: "event-delivery-audit-reused"
    });

    expect(() =>
      repo.createDelivery({
        delivery_id: "delivery-audit-reuse",
        agent_target: "codex",
        workspace_id: "workspace-1",
        run_id: "run-1",
        delivered_object_ids: ["memory-2"],
        delivered_at: "2026-04-30T10:02:00.000Z",
        audit_event_id: "event-delivery-audit-reused"
      })
    ).toThrowError(expect.objectContaining({
      code: "CONFLICT",
      message: "Trust delivery delivery-audit-reuse already uses audit event event-delivery-audit-reused."
    }));
  });

  it("rejects duplicate usage proof without replacing the original audit_event_id", async () => {
    const repo = createRepo();

    await repo.createDelivery({
      delivery_id: "delivery-usage-duplicate",
      agent_target: "codex",
      workspace_id: "workspace-1",
      run_id: "run-1",
      delivered_object_ids: ["memory-1"],
      delivered_at: "2026-04-30T10:00:00.000Z",
      audit_event_id: "event-delivery-usage-duplicate"
    });
    await repo.createUsage({
      delivery_id: "delivery-usage-duplicate",
      usage_state: "used",
      used_object_ids: ["memory-1"],
      reason: "first report",
      reported_at: "2026-04-30T10:01:00.000Z",
      audit_event_id: "event-usage-original"
    });

    expect(() =>
      repo.createUsage({
        delivery_id: "delivery-usage-duplicate",
        usage_state: "skipped",
        used_object_ids: [],
        reason: "replacement report",
        reported_at: "2026-04-30T10:02:00.000Z",
        audit_event_id: "event-usage-replacement"
      })
    ).toThrowError(expect.objectContaining({
      code: "CONFLICT",
      message: "Trust usage proof for delivery delivery-usage-duplicate already exists."
    }));

    await expect(repo.listUsageByDeliveryIds(["delivery-usage-duplicate"])).resolves.toEqual([
      {
        delivery_id: "delivery-usage-duplicate",
        usage_state: "used",
        used_object_ids: ["memory-1"],
        reason: "first report",
        reported_at: "2026-04-30T10:01:00.000Z",
        audit_event_id: "event-usage-original"
      }
    ]);
  });

  it("rejects duplicate usage audit_event_id with a distinct conflict message", async () => {
    const repo = createRepo();

    await repo.createDelivery({
      delivery_id: "delivery-usage-audit-original",
      agent_target: "codex",
      workspace_id: "workspace-1",
      run_id: "run-1",
      delivered_object_ids: ["memory-1"],
      delivered_at: "2026-04-30T10:00:00.000Z",
      audit_event_id: "event-delivery-usage-audit-original"
    });
    await repo.createDelivery({
      delivery_id: "delivery-usage-audit-reuse",
      agent_target: "codex",
      workspace_id: "workspace-1",
      run_id: "run-1",
      delivered_object_ids: ["memory-2"],
      delivered_at: "2026-04-30T10:02:00.000Z",
      audit_event_id: "event-delivery-usage-audit-reuse"
    });
    await repo.createUsage({
      delivery_id: "delivery-usage-audit-original",
      usage_state: "used",
      used_object_ids: ["memory-1"],
      reason: "first report",
      reported_at: "2026-04-30T10:01:00.000Z",
      audit_event_id: "event-usage-audit-reused"
    });

    expect(() =>
      repo.createUsage({
        delivery_id: "delivery-usage-audit-reuse",
        usage_state: "used",
        used_object_ids: ["memory-2"],
        reason: "second report",
        reported_at: "2026-04-30T10:03:00.000Z",
        audit_event_id: "event-usage-audit-reused"
      })
    ).toThrowError(expect.objectContaining({
      code: "CONFLICT",
      message:
        "Trust usage proof for delivery delivery-usage-audit-reuse already uses audit event event-usage-audit-reused."
    }));
  });

  it("creates a covering index for agent-target delivery listing order", () => {
    const database = initDatabase({ filename: ":memory:" });
    databases.add(database);

    const rows = database.connection
      .prepare("PRAGMA index_info('idx_trust_context_delivery_agent_target_delivered_at')")
      .all() as Array<{ readonly name: string }>;

    expect(rows.map((row) => row.name)).toEqual(["agent_target", "delivered_at", "delivery_id"]);
  });

  it("survives repository recreation on the same SQLite file", async () => {
    const database = initDatabase({ filename: ":memory:" });
    databases.add(database);
    const first = new SqliteTrustStateRepo(database);
    await first.createDelivery({
      delivery_id: "delivery-restart",
      agent_target: "codex",
      workspace_id: "workspace-1",
      run_id: null,
      delivered_object_ids: ["memory-1"],
      delivered_at: "2026-04-30T10:00:00.000Z",
      audit_event_id: "event-delivery-restart"
    });

    const second = new SqliteTrustStateRepo(database);
    await expect(second.findDeliveryById("delivery-restart")).resolves.toMatchObject({
      delivery_id: "delivery-restart",
      agent_target: "codex"
    });
  });
});

function createRepo(): SqliteTrustStateRepo {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  return new SqliteTrustStateRepo(database);
}
