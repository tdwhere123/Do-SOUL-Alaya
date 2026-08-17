import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EventPublisher,
  MemoryService,
  type RuntimeNotifier
} from "@do-soul/alaya-core";
import {
  FormationKind,
  MemoryDimension,
  MemoryGovernanceEventType,
  RecallContextEventType,
  ScopeClass,
  SourceKind,
  StorageTier,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import {
  initDatabase,
  SqliteEventLogRepo,
  SqliteMemoryEntryRepo,
  SqliteTrustStateRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { createMcpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";
import { createTrustStateRecorder } from "../../../trust/state.js";

const databases = new Set<StorageDatabase>();
const MEMORY_ID = "11111111-2222-4222-8222-333333333333";

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
});

describe("context usage telemetry isolation", () => {
  it("does not promote or activate a used WARM memory", async () => {
    const harness = await createHarness({
      storage_tier: StorageTier.WARM,
      activation_score: 0.4
    });

    const result = await reportUsed(harness, [MEMORY_ID]);

    expect(result).toMatchObject({ ok: true });
    await expectNoMutation(harness, StorageTier.WARM, 0.4);
    await expectUsageTelemetry(harness, 1);
  });

  it("does not promote or activate a used COLD memory", async () => {
    const harness = await createHarness({
      storage_tier: StorageTier.COLD,
      activation_score: 0.96
    });

    const result = await reportUsed(harness, [MEMORY_ID]);

    expect(result).toMatchObject({ ok: true });
    await expectNoMutation(harness, StorageTier.COLD, 0.96);
    await expectUsageTelemetry(harness, 1);
  });

  it("does not emit a promotion for HOT memory usage", async () => {
    const harness = await createHarness({
      storage_tier: StorageTier.HOT,
      activation_score: 0.4
    });

    const result = await reportUsed(harness, [MEMORY_ID]);

    expect(result).toMatchObject({ ok: true });
    await expectNoMutation(harness, StorageTier.HOT, 0.4);
    await expectUsageTelemetry(harness, 1);
  });

  it("records concurrent reports without using memory mutation as serialization", async () => {
    const harness = await createHarness({
      storage_tier: StorageTier.WARM,
      activation_score: 0.4
    });
    await harness.trustStateRecorder.recordDelivery({
      delivery_id: "delivery-2",
      agent_target: "codex",
      workspace_id: "workspace-1",
      run_id: "run-1",
      delivered_object_ids: [MEMORY_ID],
      delivered_at: "2026-05-07T00:00:00.000Z"
    });

    const [first, second] = await Promise.all([
      reportUsed(harness, [MEMORY_ID]),
      reportUsageWithDelivery(harness, "delivery-2", "used", [MEMORY_ID])
    ]);

    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true });
    await expectNoMutation(harness, StorageTier.WARM, 0.4);
    await expectUsageTelemetry(harness, 2);
  });

  it("does not promote skipped or not_applicable usage reports", async () => {
    const skipped = await createHarness({
      storage_tier: StorageTier.WARM,
      activation_score: 0.4,
      deliveryId: "delivery-skipped"
    });
    const notApplicable = await createHarness({
      storage_tier: StorageTier.COLD,
      activation_score: 0.7,
      deliveryId: "delivery-not-applicable"
    });

    expect(await reportUsage(skipped, "skipped", [])).toMatchObject({ ok: true });
    expect(await reportUsage(notApplicable, "not_applicable", [])).toMatchObject({ ok: true });

    await expectNoMutation(skipped, StorageTier.WARM, 0.4);
    await expectNoMutation(notApplicable, StorageTier.COLD, 0.7);
    await expectUsageTelemetry(skipped, 1);
    await expectUsageTelemetry(notApplicable, 1);
  });
});

async function createHarness(options: {
  readonly storage_tier: StorageTier;
  readonly activation_score: number;
  readonly deliveryId?: string;
}) {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const memoryEntryRepo = new SqliteMemoryEntryRepo(database);
  const trustStateRepo = new SqliteTrustStateRepo(database);
  const runtimeNotifier: RuntimeNotifier = {
    notify: () => {},
    notifyEntry: () => {}
  };
  const eventPublisher = new EventPublisher({
    eventLogRepo,
    runHotStateService: { apply: () => {} },
    runtimeNotifier
  });
  const trustStateRecorder = createTrustStateRecorder({
    eventPublisher,
    repo: trustStateRepo,
    ready: true,
    clock: () => "2026-05-07T00:00:00.000Z"
  });
  const memoryService = new MemoryService({
    memoryEntryRepo,
    evidenceService: { findById: async () => ({ object_id: "evidence-1" }) },
    eventLogRepo,
    runtimeNotifier,
    now: () => "2026-05-07T00:00:00.000Z"
  });
  const deliveryId = options.deliveryId ?? "delivery-1";

  await memoryEntryRepo.create(createMemoryEntry(options));
  await trustStateRecorder.recordDelivery({
    delivery_id: deliveryId,
    agent_target: "codex",
    workspace_id: "workspace-1",
    run_id: "run-1",
    delivered_object_ids: [MEMORY_ID],
    delivered_at: "2026-05-07T00:00:00.000Z"
  });

  const handler = createMcpMemoryToolHandler({
    recallService: {
      recall: vi.fn(async () => ({
        candidates: [],
        active_constraints: [],
        active_constraints_count: 0,
        total_scanned: 0,
        coarse_filter_count: 0,
        fine_assessment_count: 0
      }))
    },
    memoryService: {
      findById: memoryService.findById.bind(memoryService),
      findByIdScoped: async (objectId, workspaceId) => {
        return await memoryService.findByIdScoped(objectId, workspaceId);
      },
      findByIdsScoped: async (objectIds, workspaceId) => {
        return await memoryService.findByIdsScoped(objectIds, workspaceId);
      },
      update: memoryService.update.bind(memoryService),
      validateUpdate: memoryService.validateUpdate.bind(memoryService)
    },
    signalService: {
      receiveSignal: vi.fn(async (signal) => ({ signal }))
    },
    graphExploreService: {
      exploreOneHop: vi.fn(async () => [])
    },
    sessionOverrideService: {
      apply: vi.fn(async () => ({ runtime_id: "override-1" }))
    },
    trustStateRecorder,
    eventPublisher,
    memoryEntryRepo,
    now: () => "2026-05-07T00:00:01.000Z",
    generateId: () => "00000000-0000-4000-8000-000000000001"
  });

  return {
    deliveryId,
    eventLogRepo,
    handler,
    memoryEntryRepo,
    trustStateRecorder
  };
}

async function reportUsed(
  harness: Awaited<ReturnType<typeof createHarness>>,
  usedObjectIds: readonly string[]
) {
  return await reportUsage(harness, "used", usedObjectIds);
}

async function reportUsage(
  harness: Awaited<ReturnType<typeof createHarness>>,
  usageState: "used" | "skipped" | "not_applicable",
  usedObjectIds: readonly string[]
) {
  return await reportUsageWithDelivery(harness, harness.deliveryId, usageState, usedObjectIds);
}

async function reportUsageWithDelivery(
  harness: Awaited<ReturnType<typeof createHarness>>,
  deliveryId: string,
  usageState: "used" | "skipped" | "not_applicable",
  usedObjectIds: readonly string[]
) {
  return await harness.handler.call({
    toolName: "soul.report_context_usage",
    arguments: {
      delivery_id: deliveryId,
      usage_state: usageState,
      used_object_ids: usedObjectIds,
      reason: "recall-hit test"
    },
    context: {
      workspaceId: "workspace-1",
      runId: "run-1",
      agentTarget: "codex",
      sessionId: "recall-hit-tier-promotion-session",
    }
  });
}

async function expectNoMutation(
  harness: Awaited<ReturnType<typeof createHarness>>,
  expectedTier: StorageTier,
  expectedActivation: number
) {
  const memory = await harness.memoryEntryRepo.findById(MEMORY_ID);
  expect(memory?.storage_tier).toBe(expectedTier);
  expect(memory?.activation_score).toBe(expectedActivation);

  const events = await harness.eventLogRepo.queryByType(
    MemoryGovernanceEventType.SOUL_MEMORY_TIER_PROMOTED
  );
  expect(events).toHaveLength(0);
}

async function expectUsageTelemetry(
  harness: Awaited<ReturnType<typeof createHarness>>,
  expectedCount: number
) {
  const events = await harness.eventLogRepo.queryByType(
    RecallContextEventType.SOUL_CONTEXT_USAGE_REPORTED
  );
  expect(events).toHaveLength(expectedCount);
  expect(events).toEqual(expect.arrayContaining([
    expect.objectContaining({
      workspace_id: "workspace-1",
      run_id: "run-1",
      caused_by: "codex"
    })
  ]));
}

function createMemoryEntry(overrides: {
  readonly storage_tier: StorageTier;
  readonly activation_score: number;
}): MemoryEntry {
  return {
    object_id: MEMORY_ID,
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-05-07T00:00:00.000Z",
    updated_at: "2026-05-07T00:00:00.000Z",
    created_by: "recall-hit-test",
    dimension: MemoryDimension.PREFERENCE,
    source_kind: SourceKind.USER,
    formation_kind: FormationKind.EXPLICIT,
    scope_class: ScopeClass.PROJECT,
    content: "Use the local memory plane when recall surfaces this preference.",
    domain_tags: ["recall"],
    evidence_refs: [],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: overrides.storage_tier,
    activation_score: overrides.activation_score,
    retention_score: 0.9,
    manifestation_state: "excerpt",
    retention_state: "working",
    decay_profile: "stable",
    confidence: 1,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: 0,
    contradiction_count: 0,
    superseded_by: null
  };
}
