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
} from "../path-plasticity-runtime.js";

/**
 * Per-workspace high-water mark for the path-plasticity Librarian task
 * resolves before enqueue and advances only after successful processing.
 * The storage-backed tests below pin the durable restart behavior.
 */
describe("path-plasticity watermark registry", () => {
  it("first enqueue on a workspace returns nowIso - 24h without advancing", () => {
    const registry = createPathPlasticityWatermarkRegistry();
    const sinceIso = registry.getSince("workspace-1", "2026-05-05T12:00:00.000Z");
    // 2026-05-05T12:00 - 24h = 2026-05-04T12:00
    expect(sinceIso).toBe("2026-05-04T12:00:00.000Z");
    expect(registry.getSince("workspace-1", "2026-05-05T12:30:00.000Z")).toBe(
      "2026-05-04T12:30:00.000Z"
    );
  });

  it("second enqueue on same workspace returns the prior successful watermark, not now-24h", () => {
    const registry = createPathPlasticityWatermarkRegistry();
    registry.getSince("workspace-1", "2026-05-05T12:00:00.000Z");
    registry.markProcessed(
      "workspace-1",
      "2026-05-05T12:00:00.000Z",
      null,
      "2026-05-05T12:00:01.000Z"
    );
    const sinceIso = registry.getSince("workspace-1", "2026-05-05T12:30:00.000Z");
    expect(sinceIso).toBe("2026-05-05T12:00:00.000Z");
  });

  it("watermarks are isolated per workspace", () => {
    const registry = createPathPlasticityWatermarkRegistry();
    registry.getSince("workspace-1", "2026-05-05T12:00:00.000Z");
    registry.markProcessed("workspace-1", "2026-05-05T12:00:00.000Z");
    const sinceWs2 = registry.getSince("workspace-2", "2026-05-05T12:30:00.000Z");
    // workspace-2 has never been seen; bootstraps from now-24h.
    expect(sinceWs2).toBe("2026-05-04T12:30:00.000Z");

    const sinceWs1Tick3 = registry.getSince("workspace-1", "2026-05-05T13:00:00.000Z");
    // workspace-1 still uses its own watermark, unaffected by workspace-2's.
    expect(sinceWs1Tick3).toBe("2026-05-05T12:00:00.000Z");
  });

  it("custom initialLookbackMs replaces the default 24h", () => {
    const registry = createPathPlasticityWatermarkRegistry({
      initialLookbackMs: 60 * 60 * 1000 // 1h
    });
    const sinceIso = registry.getSince("workspace-1", "2026-05-05T12:00:00.000Z");
    expect(sinceIso).toBe("2026-05-05T11:00:00.000Z");
  });

  it("restarted registries resume from the durable SQLite watermark", () => {
    const database = initDatabase({ filename: ":memory:" });
    try {
      seedWorkspace(database);
      const firstRepo = new SqlitePathPlasticityWatermarkRepo(database);
      const firstRegistry = createPathPlasticityWatermarkRegistry({
        watermarkRepo: firstRepo
      });

      expect(firstRegistry.getSince("workspace-1", "2026-05-05T12:00:00.000Z")).toBe(
        "2026-05-04T12:00:00.000Z"
      );
      firstRegistry.markProcessed(
        "workspace-1",
        "2026-05-05T12:00:00.000Z",
        null,
        "2026-05-05T12:00:01.000Z"
      );
      expect(firstRepo.findByWorkspaceId("workspace-1")?.last_processed_reported_at).toBe(
        "2026-05-05T12:00:00.000Z"
      );

      const restartedRepo = new SqlitePathPlasticityWatermarkRepo(database);
      const restartedRegistry = createPathPlasticityWatermarkRegistry({
        watermarkRepo: restartedRepo
      });
      expect(restartedRegistry.getSince("workspace-1", "2026-05-05T12:30:00.000Z")).toBe(
        "2026-05-05T12:00:00.000Z"
      );
    } finally {
      database.close();
    }
  });

  it("a failed task does not durably advance and restart replays the same window", () => {
    const database = initDatabase({ filename: ":memory:" });
    try {
      seedWorkspace(database);
      const firstRepo = new SqlitePathPlasticityWatermarkRepo(database);
      const firstRegistry = createPathPlasticityWatermarkRegistry({
        watermarkRepo: firstRepo
      });

      expect(firstRegistry.getSince("workspace-1", "2026-05-05T12:00:00.000Z")).toBe(
        "2026-05-04T12:00:00.000Z"
      );
      expect(firstRepo.findByWorkspaceId("workspace-1")).toBeNull();

      const restartedRegistry = createPathPlasticityWatermarkRegistry({
        watermarkRepo: new SqlitePathPlasticityWatermarkRepo(database)
      });
      expect(restartedRegistry.getSince("workspace-1", "2026-05-05T12:30:00.000Z")).toBe(
        "2026-05-04T12:30:00.000Z"
      );
    } finally {
      database.close();
    }
  });

  it("does not advance the same-process in-memory watermark when durable upsert fails", () => {
    const watermarkRepo = {
      findByWorkspaceId: vi.fn(() => null),
      upsert: vi.fn(() => {
        throw new Error("watermark upsert failed");
      })
    };
    const registry = createPathPlasticityWatermarkRegistry({ watermarkRepo });

    expect(registry.getSince("workspace-1", "2026-05-05T12:00:00.000Z")).toBe(
      "2026-05-04T12:00:00.000Z"
    );
    expect(() =>
      registry.markProcessed(
        "workspace-1",
        "2026-05-05T12:00:00.000Z",
        null,
        "2026-05-05T12:00:01.000Z"
      )
    ).toThrow("watermark upsert failed");

    expect(registry.getSince("workspace-1", "2026-05-05T12:30:00.000Z")).toBe(
      "2026-05-04T12:30:00.000Z"
    );
  });

  it("advances the durable watermark when path mutation commits but post-commit propagation never settles", async () => {
    const database = initDatabase({ filename: ":memory:" });
    try {
      seedWorkspace(database);
      const eventLogRepo = new SqliteEventLogRepo(database);
      const pathRelationRepo = new SqlitePathRelationRepo(database);
      const watermarkRepo = new SqlitePathPlasticityWatermarkRepo(database);
      const trustStateRepo = new SqliteTrustStateRepo(database);

      await pathRelationRepo.create(createPathRelation({
        path_id: "path-hung-propagation-1",
        plasticity_state: {
          strength: 0.5,
          direction_bias: "source_to_target",
          stability_class: "normal",
          support_events_count: 0,
          contradiction_events_count: 0
        }
      }));

      const seedPublisher = new EventPublisher({
        eventLogRepo,
        runHotStateService: { apply: () => undefined },
        runtimeNotifier: { notify: () => undefined, notifyEntry: () => undefined }
      });
      await seedPublisher.publish({
        event_type: TrustStateEventType.MEMORY_USAGE_REPORTED,
        entity_type: "trust_usage_proof",
        entity_id: "delivery-hung-propagation-1",
        workspace_id: "workspace-1",
        run_id: null,
        caused_by: "test",
        payload_json: {
          delivery_id: "delivery-hung-propagation-1",
          usage_state: "used",
          used_object_ids: ["memory-2"],
          reason: null,
          reported_at: "2026-05-05T11:30:00.000Z"
        }
      });

      const notifyEntry = vi.fn(() => new Promise<void>(() => undefined));
      const pathPlasticityPublisher = new EventPublisher({
        eventLogRepo,
        runHotStateService: { apply: () => undefined },
        runtimeNotifier: { notify: () => undefined, notifyEntry }
      });
      const pathPlasticityService = createPathPlasticityService({
        eventLogRepo,
        trustStateRepo,
        pathRelationRepo,
        eventPublisher: pathPlasticityPublisher,
        now: () => "2026-05-05T12:00:00.000Z"
      });
      const watermark = createPathPlasticityWatermarkRegistry({ watermarkRepo });
      const scheduler = { reportCompletion: vi.fn(async () => undefined) };
      const librarian = new Librarian({
        mergePort: {
          findMergeCandidates: vi.fn(async () => []),
          hasPendingMergeProposal: vi.fn(async () => false),
          createMergeProposal: vi.fn(async () => ({ proposal_id: "proposal-1" })),
          findTemplateClusters: vi.fn(async () => []),
          hasPendingTemplateProposal: vi.fn(async () => false),
          createTemplateCandidate: vi.fn(async () => ({ candidate_id: "template-1" }))
        },
        neighborPort: { findSubjectNeighbors: vi.fn(async () => []) },
        compressionPort: {
          findCompressiblePaths: vi.fn(async () => []),
          createCompressionCandidate: vi.fn(async () => ({ candidate_id: "compression-1" }))
        },
        synthesisPort: {
          findSynthesisCandidateClusters: vi.fn(async () => []),
          hasPendingSynthesisForSubject: vi.fn(async () => false),
          createSynthesisReviewCandidate: vi.fn(async () => ({ candidate_id: "synthesis-1" }))
        },
        pathPlasticityPort: {
          computeAndApplyPlasticity: pathPlasticityService.computeAndApplyPlasticity.bind(
            pathPlasticityService
          ),
          markProcessed: (params) => watermark.markProcessed(
            params.workspaceId,
            params.processedThroughIso,
            params.processedAuditEventId ?? null,
            "2026-05-05T12:00:01.000Z"
          )
        },
        scheduler,
        pathPlasticityBudgetMs: 5,
        now: () => "2026-05-05T12:00:00.000Z"
      });

      const result = await withTestTimeout(
        librarian.run({
          task_id: "task-hung-propagation-1",
          task_kind: GardenTaskKind.PATH_PLASTICITY_UPDATE,
          required_tier: GardenTier.TIER_2,
          workspace_id: "workspace-1",
          run_id: null,
          target_object_refs: [
            "2026-05-05T11:00:00.000Z",
            "2026-05-05T12:00:00.000Z"
          ],
          priority: 50,
          created_at: "2026-05-05T12:00:00.000Z"
        }),
        100,
        "Librarian hung after durable path mutation entered detached propagation."
      );

      expect(result.success).toBe(true);
      expect(result.role).toBe(GardenRole.LIBRARIAN);
      expect(result.tier).toBe(GardenTier.TIER_2);
      expect(result.objects_affected).toEqual(["path-hung-propagation-1"]);
      expect(watermarkRepo.findByWorkspaceId("workspace-1")?.last_processed_reported_at).toBe(
        "2026-05-05T12:00:00.000Z"
      );
      expect(notifyEntry).toHaveBeenCalled();
      expect(scheduler.reportCompletion).toHaveBeenCalledWith(result);
      expect((await pathRelationRepo.findById("path-hung-propagation-1"))?.plasticity_state.strength).toBeCloseTo(
        0.6,
        10
      );
    } finally {
      database.close();
    }
  });
});

describe("usage-proof reader", () => {
  it("asks EventLog for the workspace/type/since slice instead of filtering all workspace rows in memory", async () => {
    const usageEvent = createEventLogEntry({
      event_id: "usage-event-1",
      event_type: TrustStateEventType.MEMORY_USAGE_REPORTED,
      entity_type: "trust_usage_proof",
      entity_id: "delivery-1",
      payload_json: {
        delivery_id: "delivery-1",
        usage_state: "used",
        used_object_ids: ["memory-1"],
        per_anchor_usage: [{ object_id: "memory-1", anchor_role: "target" }],
        reason: null,
        reported_at: "2026-05-05T12:01:00.000Z"
      }
    });
    const eventLogRepo = {
      queryByWorkspaceAndType: vi.fn(async () => [usageEvent])
    };
    const reader = createUsageProofReader({
      eventLogRepo,
      trustStateRepo: {
        findDeliveryById: vi.fn(async () => null)
      }
    });

    const records = await reader.listRecentUsage(
      "workspace-1",
      "2026-05-05T12:00:00.000Z",
      "2026-05-05T12:30:00.000Z"
    );

    expect(eventLogRepo.queryByWorkspaceAndType).toHaveBeenCalledWith(
      "workspace-1",
      TrustStateEventType.MEMORY_USAGE_REPORTED,
      "2026-05-05T12:00:00.000Z",
      "2026-05-05T12:30:00.000Z"
    );
    expect(records.map((record) => record.audit_event_id)).toEqual(["usage-event-1"]);
    expect(records[0]?.per_anchor_usage).toEqual([{ object_id: "memory-1", anchor_role: "target" }]);
  });
});

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
