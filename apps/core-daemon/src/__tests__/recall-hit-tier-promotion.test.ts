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
import { createMcpMemoryToolHandler } from "../mcp-memory-tool-handler.js";
import { createTrustStateRecorder } from "../trust-state.js";

const databases = new Set<StorageDatabase>();
const RECALL_HIT_ACTIVATION_BUMP = 0.05;
const MEMORY_ID = "11111111-2222-4222-8222-333333333333";

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
});

describe("recall-hit tier promotion", () => {
  it("promotes a used WARM memory to HOT and bumps activation", async () => {
    const harness = await createHarness({
      storage_tier: StorageTier.WARM,
      activation_score: 0.4
    });

    const result = await reportUsed(harness, [MEMORY_ID]);

    expect(result).toMatchObject({ ok: true });
    await expectPromoted(harness, {
      fromTier: StorageTier.WARM,
      previousActivation: 0.4,
      expectedActivation: 0.45
    });
  });

  it("promotes a used COLD memory to HOT", async () => {
    const harness = await createHarness({
      storage_tier: StorageTier.COLD,
      activation_score: 0.96
    });

    const result = await reportUsed(harness, [MEMORY_ID]);

    expect(result).toMatchObject({ ok: true });
    await expectPromoted(harness, {
      fromTier: StorageTier.COLD,
      previousActivation: 0.96,
      expectedActivation: 1
    });
  });

  it("does not emit a promotion for HOT memory usage", async () => {
    const harness = await createHarness({
      storage_tier: StorageTier.HOT,
      activation_score: 0.4
    });

    const result = await reportUsed(harness, [MEMORY_ID]);

    expect(result).toMatchObject({ ok: true });
    await expectNoPromotion(harness, {
      expectedTier: StorageTier.HOT,
      expectedActivation: 0.4
    });
  });

  it("serializes two concurrent used reports into one promotion event", async () => {
    const barrier = createReadBarrier(2);
    const harness = await createHarness({
      storage_tier: StorageTier.WARM,
      activation_score: 0.4,
      afterFindByIdScoped: barrier
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
    await expectPromoted(harness, {
      fromTier: StorageTier.WARM,
      previousActivation: 0.4,
      expectedActivation: 0.45
    });
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

    await expectNoPromotion(skipped, {
      expectedTier: StorageTier.WARM,
      expectedActivation: 0.4
    });
    await expectNoPromotion(notApplicable, {
      expectedTier: StorageTier.COLD,
      expectedActivation: 0.7
    });
  });
});

async function createHarness(options: {
  readonly storage_tier: StorageTier;
  readonly activation_score: number;
  readonly deliveryId?: string;
  readonly afterFindByIdScoped?: () => Promise<void>;
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
        const entry = await memoryService.findByIdScoped(objectId, workspaceId);
        await options.afterFindByIdScoped?.();
        return entry;
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

async function expectPromoted(
  harness: Awaited<ReturnType<typeof createHarness>>,
  expected: {
    readonly fromTier: StorageTier;
    readonly previousActivation: number;
    readonly expectedActivation: number;
  }
) {
  const memory = await harness.memoryEntryRepo.findById(MEMORY_ID);
  expect(memory?.storage_tier).toBe(StorageTier.HOT);
  expect(memory?.activation_score).toBeCloseTo(expected.expectedActivation, 10);
  expect((memory?.activation_score ?? 0) - expected.previousActivation).toBeLessThanOrEqual(
    RECALL_HIT_ACTIVATION_BUMP
  );

  const events = await harness.eventLogRepo.queryByType(
    MemoryGovernanceEventType.SOUL_MEMORY_TIER_PROMOTED
  );
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    event_type: MemoryGovernanceEventType.SOUL_MEMORY_TIER_PROMOTED,
    entity_type: "memory_entry",
    entity_id: MEMORY_ID,
    workspace_id: "workspace-1",
    run_id: "run-1"
  });
  expect(events[0]?.payload_json).toMatchObject({
    object_id: MEMORY_ID,
    object_kind: "memory_entry",
    workspace_id: "workspace-1",
    run_id: "run-1",
    from_tier: expected.fromTier,
    to_tier: StorageTier.HOT,
    reason: "recall_hit",
    occurred_at: "2026-05-07T00:00:01.000Z"
  });
}

async function expectNoPromotion(
  harness: Awaited<ReturnType<typeof createHarness>>,
  expected: {
    readonly expectedTier: StorageTier;
    readonly expectedActivation: number;
  }
) {
  const memory = await harness.memoryEntryRepo.findById(MEMORY_ID);
  expect(memory?.storage_tier).toBe(expected.expectedTier);
  expect(memory?.activation_score).toBe(expected.expectedActivation);
  const events = await harness.eventLogRepo.queryByType(
    MemoryGovernanceEventType.SOUL_MEMORY_TIER_PROMOTED
  );
  expect(events).toHaveLength(0);
}

function createReadBarrier(expectedReads: number): () => Promise<void> {
  let reads = 0;
  let release: (() => void) | null = null;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });

  return async () => {
    reads += 1;
    if (reads >= expectedReads) {
      release?.();
    }
    await promise;
  };
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
