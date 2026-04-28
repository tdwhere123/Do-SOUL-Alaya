import { describe, expect, it, vi } from "vitest";
import {
  MemoryDimension,
  Phase1BEventType,
  ScopeClass,
  StorageTier,
  type EventLogEntry,
  type KarmaEvent,
  type MemoryEntry
} from "@do-what/protocol";
import {
  DynamicsService,
  type DynamicsServiceDependencies,
  type DynamicsUpdateFields
} from "../dynamics-service.js";

const NOW = "2026-03-28T10:00:00.000Z";
const SEVEN_DAYS_AGO = new Date(Date.parse(NOW) - 7 * 86_400_000).toISOString();
const THIRTY_DAYS_AGO = new Date(Date.parse(NOW) - 30 * 86_400_000).toISOString();

function createMemory(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: "memory-1",
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: SEVEN_DAYS_AGO,
    updated_at: SEVEN_DAYS_AGO,
    created_by: "system",
    dimension: MemoryDimension.PROCEDURE,
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: ScopeClass.PROJECT,
    content: "Use pnpm for workspace commands.",
    domain_tags: ["tooling"],
    evidence_refs: [],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: StorageTier.HOT,
    activation_score: 0.5,
    retention_score: 0.8,
    manifestation_state: "excerpt",
    retention_state: "working",
    decay_profile: "stable",
    confidence: 0.9,
    last_used_at: NOW,
    last_hit_at: NOW,
    reinforcement_count: 2,
    contradiction_count: 0,
    superseded_by: null,
    ...overrides
  };
}

function createDependencies(memories: readonly MemoryEntry[]): {
  readonly deps: DynamicsServiceDependencies;
  readonly updateDynamics: ReturnType<typeof vi.fn>;
  readonly append: ReturnType<typeof vi.fn>;
} {
  const updateDynamics = vi.fn(
    async (_objectId: string, fields: DynamicsUpdateFields, updatedAt: string): Promise<MemoryEntry> =>
      createMemory({
        ...memories[0],
        ...fields,
        updated_at: updatedAt
      })
  );
  const append = vi.fn(
    async (entry: Omit<EventLogEntry, "event_id" | "created_at">): Promise<EventLogEntry> => ({
      event_id: `event-${entry.event_type}-${entry.revision}`,
      created_at: NOW,
      ...entry
    })
  );

  return {
    deps: {
      now: () => NOW,
      memoryRepo: {
        findById: vi.fn(async () => memories[0] ?? null),
        findByWorkspaceId: vi.fn(async () => memories),
        updateDynamics
      },
      karmaEventRepo: {
        create: vi.fn(async (event: Readonly<KarmaEvent>) => event),
        sumByObjectId: vi.fn(async () => 0),
        sumByObjectIds: vi.fn(async () => Object.fromEntries(memories.map((memory) => [memory.object_id, 0]))),
        findByObjectId: vi.fn(async () => [])
      },
      eventLogRepo: {
        append,
        queryByEntity: vi.fn(async () => [])
      },
      sseBroadcaster: {
        broadcastEntry: vi.fn(async () => undefined)
      }
    },
    updateDynamics,
    append
  };
}

describe("DynamicsService retention state transitions", () => {
  it("promotes working to consolidated when age, retention, and reinforcement qualify", async () => {
    const memory = createMemory({
      retention_state: "working",
      created_at: SEVEN_DAYS_AGO,
      reinforcement_count: 1,
      retention_score: 0.6
    });
    const { deps, updateDynamics } = createDependencies([memory]);
    const service = new DynamicsService(deps);

    await service.scanRetentionDecay("workspace-1");

    expect(updateDynamics).toHaveBeenCalledWith(
      "memory-1",
      expect.objectContaining({
        retention_state: "consolidated"
      }),
      NOW
    );
  });

  it("promotes consolidated to canon when age, retention, and reinforcement qualify", async () => {
    const memory = createMemory({
      retention_state: "consolidated",
      created_at: THIRTY_DAYS_AGO,
      reinforcement_count: 3,
      retention_score: 0.75
    });
    const { deps, updateDynamics } = createDependencies([memory]);
    const service = new DynamicsService(deps);

    await service.scanRetentionDecay("workspace-1");

    expect(updateDynamics).toHaveBeenCalledWith(
      "memory-1",
      expect.objectContaining({
        retention_state: "canon"
      }),
      NOW
    );
  });

  it("regresses consolidated to working when retention drops below threshold", async () => {
    const memory = createMemory({
      retention_state: "consolidated",
      retention_score: 0.2,
      decay_profile: "volatile",
      created_at: "2026-03-01T10:00:00.000Z",
      last_used_at: "2026-03-02T10:00:00.000Z",
      last_hit_at: "2026-03-02T10:00:00.000Z"
    });
    const { deps, updateDynamics } = createDependencies([memory]);
    const service = new DynamicsService(deps);

    await service.scanRetentionDecay("workspace-1");

    expect(updateDynamics).toHaveBeenCalledWith(
      "memory-1",
      expect.objectContaining({
        retention_state: "working"
      }),
      NOW
    );
  });

  it("marks archived memories as tombstoned when superseded_by is set", async () => {
    const memory = createMemory({
      lifecycle_state: "archived",
      retention_state: "archived",
      superseded_by: "memory-2"
    });
    const { deps, updateDynamics } = createDependencies([memory]);
    const service = new DynamicsService(deps);

    await service.scanRetentionDecay("workspace-1");

    expect(updateDynamics).toHaveBeenCalledWith(
      "memory-1",
      expect.objectContaining({
        retention_state: "tombstoned"
      }),
      NOW
    );
  });

  it("emits a state_changed event when retention_state changes", async () => {
    const memory = createMemory({
      retention_state: "working",
      created_at: SEVEN_DAYS_AGO,
      reinforcement_count: 2,
      retention_score: 0.8
    });
    const { deps, append } = createDependencies([memory]);
    const service = new DynamicsService(deps);

    await service.scanRetentionDecay("workspace-1");

    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: Phase1BEventType.SOUL_MEMORY_STATE_CHANGED
      })
    );
  });
});