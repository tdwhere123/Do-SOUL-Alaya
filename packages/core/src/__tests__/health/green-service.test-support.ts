import { vi } from "vitest";
import { FormationKind, GreenGovernanceEventType, MemoryDimension, RevokeReason, ScopeClass, SourceKind, StorageTier, type EventLogEntry, type GreenStatus, type MemoryEntry } from "@do-soul/alaya-protocol";
import { GreenService, type GreenServiceDependencies } from "../../health/green-service.js";

export function createMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-24T00:00:00.000Z",
    updated_at: "2026-03-24T00:00:00.000Z",
    created_by: "user_action",
    dimension: MemoryDimension.PREFERENCE,
    source_kind: SourceKind.USER,
    formation_kind: FormationKind.EXPLICIT,
    scope_class: ScopeClass.PROJECT,
    content: "Use pnpm for workspace commands.",
    domain_tags: ["tooling"],
    evidence_refs: ["evidence-1"],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: "surface://repo/path.ts",
    storage_tier: StorageTier.HOT,
    activation_score: 0.6,
    retention_score: 0.7,
    manifestation_state: "full_eligible",
    retention_state: "working",
    decay_profile: "stable",
    confidence: 0.9,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: 0,
    contradiction_count: 0,
    superseded_by: null,
    ...overrides
  };
}

export function createGreenStatus(overrides: Partial<GreenStatus> = {}): GreenStatus {
  return {
    object_id: "9bc1a292-e9c2-47f9-9c6f-bf6b67c810f3",
    object_kind: "green_status",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-24T00:00:00.000Z",
    updated_at: "2026-03-24T00:00:00.000Z",
    created_by: "system",
    target_object_id: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
    target_object_kind: "memory_entry",
    green_state: "eligible",
    verification_basis: "active_verification",
    verified_by: "review",
    verified_at: "2026-03-24T00:00:00.000Z",
    valid_until: "2026-04-23T00:00:00.000Z",
    bound_surfaces: ["surface://repo/path.ts"],
    bound_scope_class: "project",
    revoke_reason: "none",
    last_transition_at: "2026-03-24T00:00:00.000Z",
    workspace_id: "workspace-1",
    ...overrides
  };
}

export function createHarness(options: {
  readonly memory?: MemoryEntry;
  readonly existingStatus?: GreenStatus | null;
  readonly governanceRole?: "standalone" | "claimed" | "contested" | "winner" | null;
  readonly leaseHeld?: boolean;
  readonly initialEvents?: readonly EventLogEntry[];
} = {}) {
  const memory = options.memory ?? createMemoryEntry();
  const statuses = new Map<string, GreenStatus>();
  if (options.existingStatus !== undefined && options.existingStatus !== null) {
    statuses.set(options.existingStatus.target_object_id, { ...options.existingStatus });
  }

  const events: EventLogEntry[] = [...(options.initialEvents ?? [])];
  const warn = vi.fn();
  const notifyEntry = vi.fn(async (_entry: EventLogEntry) => undefined);
  const appendEvent = vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => {
    const created: EventLogEntry = {
      event_id: `event-${events.length + 1}`,
      created_at: "2026-03-24T00:00:00.000Z",
      revision: 0,
      ...entry
    };
    events.push(created);
    return created;
  });
  const upsertStatus = vi.fn(async (status: Readonly<GreenStatus>) => {
    const copy = { ...status };
    statuses.set(copy.target_object_id, copy);
    return Object.freeze(copy);
  });
  const dependencies: GreenServiceDependencies = {
    now: () => "2026-03-24T00:00:00.000Z",
    generateObjectId: createObjectIdGenerator(),
    warn,
    runtimeNotifier: {
      notifyEntry
    },
    greenStatusRepo: {
      findByTargetObjectId: vi.fn(async (targetObjectId: string) => {
        const found = statuses.get(targetObjectId);
        return found === undefined ? null : Object.freeze({ ...found });
      }),
      findEligible: vi.fn(async (workspaceId: string) =>
        [...statuses.values()]
          .filter((status) => status.workspace_id === workspaceId && status.green_state === "eligible")
          .map((status) => Object.freeze({ ...status }))
      ),
      findGrace: vi.fn(async (workspaceId: string) =>
        [...statuses.values()]
          .filter((status) => status.workspace_id === workspaceId && status.green_state === "grace")
          .map((status) => Object.freeze({ ...status }))
      ),
      findByWorkspaceId: vi.fn(async (workspaceId: string) =>
        [...statuses.values()]
          .filter((status) => status.workspace_id === workspaceId)
          .map((status) => Object.freeze({ ...status }))
      ),
      upsert: upsertStatus
    },
    memoryRepo: {
      findById: vi.fn(async (objectId: string) =>
        objectId === memory.object_id ? Object.freeze({ ...memory }) : null
      )
    },
    eventLogRepo: {
      append: appendEvent,
      queryByEntity: vi.fn(async (entityType, entityId) =>
        events.filter((event) => event.entity_type === entityType && event.entity_id === entityId)
      ),
      queryByWorkspace: vi.fn(async (workspaceId) =>
        events.filter((event) => event.workspace_id === workspaceId)
      ),
      queryByType: vi.fn(async (eventType) => events.filter((event) => event.event_type === eventType)),
      hasOpenSessionOverrideCorrection: vi.fn(async (query) =>
        hasOpenSessionOverrideCorrection(events, query.workspaceId, query.targetObjectId, query.nowIso)
      ),
      hasSecurityHitForTarget: vi.fn(async (query) =>
        hasSecurityHitForTarget(events, query.workspaceId, query.targetObjectId)
      )
    },
    statusResolver:
      options.governanceRole === undefined
        ? undefined
        : {
            getGovernanceRole: vi.fn(async () => options.governanceRole ?? null)
          },
    leaseService:
      options.leaseHeld === undefined
        ? undefined
        : {
            isHeld: vi.fn(async () => options.leaseHeld ?? false)
          }
  };

  return {
    service: new GreenService(dependencies),
    statuses,
    events,
    warn,
    notifyEntry,
    appendEvent,
    upsertStatus
  };
}

function hasOpenSessionOverrideCorrection(
  events: readonly EventLogEntry[],
  workspaceId: string,
  targetObjectId: string,
  nowIso: string
): boolean {
  const promotedOverrideIds = new Set(
    events.flatMap((event) => {
      const payload = event.payload_json as Record<string, unknown>;
      return event.workspace_id === workspaceId &&
        event.event_type === GreenGovernanceEventType.SOUL_SESSION_OVERRIDE_PROMOTED &&
        payload.promotion_outcome !== "not_promoted" &&
        typeof payload.override_id === "string"
        ? [payload.override_id]
        : [];
    })
  );

  return events.some((event) => {
    const payload = event.payload_json as Record<string, unknown>;
    return (
      event.workspace_id === workspaceId &&
      event.event_type === GreenGovernanceEventType.SOUL_SESSION_OVERRIDE_APPLIED &&
      payload.target_object === targetObjectId &&
      typeof payload.override_id === "string" &&
      !promotedOverrideIds.has(payload.override_id) &&
      typeof payload.expires_at === "string" &&
      new Date(payload.expires_at).getTime() > new Date(nowIso).getTime()
    );
  });
}

function hasSecurityHitForTarget(
  events: readonly EventLogEntry[],
  workspaceId: string,
  targetObjectId: string
): boolean {
  return events.some((event) => {
    const payload = event.payload_json as Record<string, unknown>;
    if (event.entity_type === "memory_entry" && event.entity_id === targetObjectId) {
      return payload.revoke_reason === RevokeReason.SECURITY_HIT;
    }
    return (
      event.workspace_id === workspaceId &&
      event.event_type === GreenGovernanceEventType.SOUL_GREEN_PIERCED &&
      payload.target_object_id === targetObjectId &&
      payload.revoke_reason === RevokeReason.SECURITY_HIT
    );
  });
}

export function createObjectIdGenerator(): () => string {
  let index = 0;

  return () => {
    const value = `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
    index += 1;
    return value;
  };
}

export function createEvent(
  overrides: Partial<EventLogEntry> & Pick<EventLogEntry, "event_type" | "entity_type" | "entity_id" | "payload_json">
): EventLogEntry {
  return {
    event_id: overrides.event_id ?? `event-${overrides.event_type}-${overrides.entity_id}`,
    created_at: overrides.created_at ?? "2026-03-24T00:00:00.000Z",
    workspace_id: overrides.workspace_id ?? "workspace-1",
    run_id: overrides.run_id ?? "run-1",
    caused_by: overrides.caused_by ?? "system",
    revision: overrides.revision ?? 0,
    ...overrides
  };
}
