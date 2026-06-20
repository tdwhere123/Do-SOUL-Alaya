import { describe, expect, it, vi } from "vitest";
import {
  GardenTaskKind,
  GardenRole,
  GardenTier,
  TrustStateEventType,
  type EventLogEntry,
  type PathRelation
} from "@do-soul/alaya-protocol";
import {
  initDatabase,
  SqliteEventLogRepo,
  SqlitePathRelationRepo,
  SqlitePathPlasticityWatermarkRepo,
  SqliteTrustStateRepo
} from "@do-soul/alaya-storage";
import { EventPublisher } from "@do-soul/alaya-core";
import { Librarian } from "@do-soul/alaya-soul";
import {
  createPathPlasticityLookupTelemetry,
  createPathPlasticityService,
  createPathPlasticityWatermarkRegistry,
  createRecallPathPlasticityPort,
  createUsageProofReader
} from "../../garden/path-plasticity-runtime.js";
function seedWorkspace(database: ReturnType<typeof initDatabase>): void {
  database.connection
    .prepare(
      `INSERT INTO workspaces (
        workspace_id,
        name,
        root_path,
        workspace_kind,
        default_engine_binding,
        workspace_state,
        created_at,
        archived_at,
        default_engine_class
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
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
function createEventLogEntry(overrides: Partial<EventLogEntry>): EventLogEntry {
  return {
    event_id: "event-1",
    event_type: TrustStateEventType.MEMORY_USAGE_REPORTED,
    entity_type: "trust_usage_proof",
    entity_id: "delivery-1",
    workspace_id: "workspace-1",
    run_id: null,
    caused_by: "test",
    revision: 0,
    payload_json: {},
    created_at: "2026-05-05T12:00:00.000Z",
    ...overrides
  } as EventLogEntry;
}
function createPathRelation(overrides: Partial<PathRelation> = {}): PathRelation {
  return {
    path_id: "path-1",
    workspace_id: "workspace-1",
    anchors: {
      source_anchor: { kind: "object", object_id: "memory-1" },
      target_anchor: { kind: "object", object_id: "memory-2" }
    },
    constitution: {
      relation_kind: "supports",
      why_this_relation_exists: ["test"]
    },
    effect_vector: {
      salience: 0.5,
      recall_bias: 0,
      verification_bias: 0,
      unfinishedness_bias: 0,
      default_manifestation_preference: "stance_bias"
    },
    plasticity_state: {
      strength: 0.5,
      direction_bias: "source_to_target",
      stability_class: "normal",
      support_events_count: 0,
      contradiction_events_count: 0
    },
    lifecycle: {
      status: "active",
      retirement_rule: "default"
    } as unknown as PathRelation["lifecycle"],
    legitimacy: {
      evidence_basis: ["evidence-1"],
      governance_class: "recall_allowed"
    },
    created_at: "2026-05-05T12:00:00.000Z",
    updated_at: "2026-05-05T12:00:00.000Z",
    ...overrides
  } as PathRelation;
}
async function withTestTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

describe("recall path-plasticity port", () => {
  it("uses one batched anchor query, applies direction_bias, and excludes lifecycle-retired paths", async () => {
    const sourceToTargetPath = createPathRelation({
      path_id: "path-source-to-target",
      plasticity_state: {
        strength: 0.8,
        direction_bias: "source_to_target",
        stability_class: "normal",
        support_events_count: 0,
        contradiction_events_count: 0
      }
    });
    const targetToSourcePath = createPathRelation({
      path_id: "path-target-to-source",
      anchors: {
        source_anchor: { kind: "object", object_id: "memory-3" },
        target_anchor: { kind: "object", object_id: "memory-4" }
      },
      plasticity_state: {
        strength: 0.7,
        direction_bias: "target_to_source",
        stability_class: "normal",
        support_events_count: 0,
        contradiction_events_count: 0
      }
    });
    const bidirectionalPath = createPathRelation({
      path_id: "path-bidirectional",
      anchors: {
        source_anchor: { kind: "object", object_id: "memory-5" },
        target_anchor: { kind: "object", object_id: "memory-6" }
      },
      plasticity_state: {
        strength: 0.6,
        direction_bias: "bidirectional_asymmetric",
        stability_class: "normal",
        support_events_count: 0,
        contradiction_events_count: 0
      }
    });
    const retiredPath = createPathRelation({
      path_id: "path-retired",
      anchors: {
        source_anchor: { kind: "object", object_id: "memory-retired" },
        target_anchor: { kind: "object", object_id: "memory-2" }
      },
      lifecycle: {
        status: "retired",
        retirement_rule: "default"
      } as unknown as PathRelation["lifecycle"],
      plasticity_state: {
        strength: 1,
        direction_bias: "source_to_target",
        stability_class: "normal",
        support_events_count: 0,
        contradiction_events_count: 0,
        last_weakened_at: "2026-05-05T12:00:00.000Z"
      }
    });
    const pathRelationRepo = {
      findByAnchors: vi.fn(async () => [
        sourceToTargetPath,
        targetToSourcePath,
        bidirectionalPath,
        retiredPath
      ])
    };
    const telemetry = createPathPlasticityLookupTelemetry({ windowSize: 4 });
    const nowValues = [100, 106];
    const port = createRecallPathPlasticityPort({
      pathRelationRepo,
      telemetry,
      nowMs: () => nowValues.shift() ?? 106
    });

    const result = await port.getStrengthByMemoryId("workspace-1", [
      "memory-1",
      "memory-2",
      "memory-3",
      "memory-4",
      "memory-5",
      "memory-6",
      "memory-1"
    ]);

    expect(pathRelationRepo.findByAnchors).toHaveBeenCalledTimes(1);
    expect(pathRelationRepo.findByAnchors).toHaveBeenCalledWith("workspace-1", [
      { kind: "object", object_id: "memory-1" },
      { kind: "object", object_id: "memory-2" },
      { kind: "object", object_id: "memory-3" },
      { kind: "object", object_id: "memory-4" },
      { kind: "object", object_id: "memory-5" },
      { kind: "object", object_id: "memory-6" }
    ]);
    expect([...result.entries()]).toEqual([
      ["memory-2", 0.8],
      ["memory-3", 0.7],
      ["memory-5", 0.6],
      ["memory-6", 0.6]
    ]);
    expect(result.has("memory-1")).toBe(false);
    expect(result.has("memory-4")).toBe(false);
    expect(result.has("memory-retired")).toBe(false);
    expect(telemetry.snapshot()).toEqual({
      lookup_count: 1,
      sample_count: 1,
      duration_p99_ms: 6,
      window_size: 4
    });
  });
});
