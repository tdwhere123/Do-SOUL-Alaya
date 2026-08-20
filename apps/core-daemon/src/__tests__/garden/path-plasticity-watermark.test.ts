import { describe, expect, it, vi } from "vitest";
import {
  initDatabase,
  SqlitePathPlasticityWatermarkRepo
} from "@do-soul/alaya-storage";
import {
  createPathPlasticityLookupTelemetry,
  createPathPlasticityWatermarkRegistry
} from "../../garden/path-plasticity/path-plasticity-runtime.js";

function seedWorkspace(database: ReturnType<typeof initDatabase>): void {
  database.connection.prepare(`
    INSERT INTO workspaces (
      workspace_id, name, root_path, workspace_kind, default_engine_binding,
      workspace_state, created_at, archived_at, default_engine_class
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "workspace-1",
    "Watermark Workspace",
    "/tmp/watermark",
    "local_repo",
    null,
    "active",
    "2026-05-05T00:00:00.000Z",
    null,
    null
  );
}

describe("path-plasticity watermark registry", () => {
  it("starts from the default 24-hour lookback without advancing", () => {
    const registry = createPathPlasticityWatermarkRegistry();

    expect(registry.getSince("workspace-1", "2026-05-05T12:00:00.000Z")).toBe(
      "2026-05-04T12:00:00.000Z"
    );
    expect(registry.getSince("workspace-1", "2026-05-05T12:30:00.000Z")).toBe(
      "2026-05-04T12:30:00.000Z"
    );
  });

  it("uses the prior successful watermark", () => {
    const registry = createPathPlasticityWatermarkRegistry();
    registry.markProcessed(
      "workspace-1",
      "2026-05-05T12:00:00.000Z",
      null,
      "2026-05-05T12:00:01.000Z"
    );

    expect(registry.getSince("workspace-1", "2026-05-05T12:30:00.000Z")).toBe(
      "2026-05-05T12:00:00.000Z"
    );
  });

  it("isolates watermarks by workspace", () => {
    const registry = createPathPlasticityWatermarkRegistry();
    registry.markProcessed(
      "workspace-1",
      "2026-05-05T12:00:00.000Z",
      null,
      "2026-05-05T12:00:01.000Z"
    );

    expect(registry.getSince("workspace-2", "2026-05-05T12:30:00.000Z")).toBe(
      "2026-05-04T12:30:00.000Z"
    );
  });

  it("supports a custom initial lookback", () => {
    const registry = createPathPlasticityWatermarkRegistry({ initialLookbackMs: 60_000 });

    expect(registry.getSince("workspace-1", "2026-05-05T12:00:00.000Z")).toBe(
      "2026-05-05T11:59:00.000Z"
    );
  });

  it("resumes from the durable SQLite watermark after restart", () => {
    const database = initDatabase({ filename: ":memory:" });
    try {
      seedWorkspace(database);
      const repo = new SqlitePathPlasticityWatermarkRepo(database);
      const first = createPathPlasticityWatermarkRegistry({ watermarkRepo: repo });
      first.markProcessed(
        "workspace-1",
        "2026-05-05T12:00:00.000Z",
        "audit-1",
        "2026-05-05T12:00:01.000Z"
      );

      const restarted = createPathPlasticityWatermarkRegistry({ watermarkRepo: repo });
      expect(restarted.getSince("workspace-1", "2026-05-05T12:30:00.000Z")).toBe(
        "2026-05-05T12:00:00.000Z"
      );
    } finally {
      database.close();
    }
  });

  it("does not advance durable state when processing fails before markProcessed", () => {
    const database = initDatabase({ filename: ":memory:" });
    try {
      seedWorkspace(database);
      const repo = new SqlitePathPlasticityWatermarkRepo(database);
      const first = createPathPlasticityWatermarkRegistry({ watermarkRepo: repo });
      expect(first.getSince("workspace-1", "2026-05-05T12:00:00.000Z")).toBe(
        "2026-05-04T12:00:00.000Z"
      );

      const restarted = createPathPlasticityWatermarkRegistry({ watermarkRepo: repo });
      expect(restarted.getSince("workspace-1", "2026-05-05T12:30:00.000Z")).toBe(
        "2026-05-04T12:30:00.000Z"
      );
    } finally {
      database.close();
    }
  });

  it("does not advance in-memory state when durable upsert fails", () => {
    const watermarkRepo = {
      findByWorkspaceId: vi.fn(() => null),
      upsert: vi.fn(() => {
        throw new Error("watermark upsert failed");
      })
    };
    const registry = createPathPlasticityWatermarkRegistry({ watermarkRepo });

    expect(() => registry.markProcessed(
      "workspace-1",
      "2026-05-05T12:00:00.000Z",
      null,
      "2026-05-05T12:00:01.000Z"
    ))
      .toThrow("watermark upsert failed");
    expect(registry.getSince("workspace-1", "2026-05-05T12:30:00.000Z")).toBe(
      "2026-05-04T12:30:00.000Z"
    );
  });
});

describe("path-plasticity lookup telemetry", () => {
  it("keeps a bounded latency window while retaining the total lookup count", () => {
    const telemetry = createPathPlasticityLookupTelemetry({ windowSize: 2 });
    telemetry.observe(3);
    telemetry.observe(7);
    telemetry.observe(5);

    expect(telemetry.snapshot()).toEqual({
      lookup_count: 3,
      sample_count: 2,
      duration_p99_ms: 7,
      window_size: 2
    });
  });

  it("resets both counters and samples", () => {
    const telemetry = createPathPlasticityLookupTelemetry();
    telemetry.observe(4);
    telemetry.reset();

    expect(telemetry.snapshot()).toEqual({
      lookup_count: 0,
      sample_count: 0,
      duration_p99_ms: null,
      window_size: 128
    });
  });
});
