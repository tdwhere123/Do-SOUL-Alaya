import { vi } from "vitest";
import {
  type EventLogEntry,
  type PathRelation,
  type SoulContextObjectIdentity,
  type UsageProofRecord
} from "@do-soul/alaya-protocol";
import {
  PathPlasticityService,
  type PathPlasticityRepoPort,
  type UsageProofReaderPort
} from "../../path-plasticity/index.js";
import { EventPublisher, type RuntimeNotifier } from "../../runtime/event-publisher.js";

export const NOW_ISO = "2026-05-04T12:00:00.000Z";
export const PAST_REINFORCED_ISO = "2026-04-01T12:00:00.000Z";
export const RECENT_REINFORCED_ISO = "2026-05-04T11:00:00.000Z";

export function createPath(overrides: Partial<PathRelation> = {}): PathRelation {
  return {
    path_id: "path-1",
    workspace_id: "workspace-1",
    anchors: {
      source_anchor: { kind: "object", object_id: "obj-source" },
      target_anchor: { kind: "object", object_id: "obj-target" }
    },
    constitution: {
      relation_kind: "supports",
      why_this_relation_exists: ["seed"]
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
      retirement_rule: "default"
    },
    legitimacy: {
      evidence_basis: ["evidence-1"],
      governance_class: "recall_allowed"
    },
    created_at: "2026-04-01T00:00:00.000Z",
    updated_at: "2026-04-01T00:00:00.000Z",
    ...overrides
  } as PathRelation;
}

let usageRecordSeq = 0;

export function createUsageRecord(overrides: Partial<UsageProofRecord> = {}): UsageProofRecord {
  // invariant: audit_event_id is the durable dedupe key. A generated
  // sequence keeps fixtures distinct unless a test overrides it.
  usageRecordSeq += 1;
  return {
    delivery_id: "delivery-1",
    usage_state: "used",
    used_object_ids: ["obj-target"],
    reason: null,
    reported_at: NOW_ISO,
    audit_event_id: `audit-event-${usageRecordSeq}`,
    ...overrides
  };
}

export function createEventLogEntry(
  overrides: Partial<EventLogEntry> & Pick<EventLogEntry, "event_type" | "entity_id">
): EventLogEntry {
  const base = {
    event_id: `evt-${overrides.entity_id}`,
    entity_type: "path_relation",
    workspace_id: "workspace-1",
    run_id: null,
    caused_by: "system",
    payload_json: {},
    created_at: NOW_ISO
  } as const;
  return {
    ...base,
    ...overrides
  } as EventLogEntry;
}

export interface Harness {
  readonly service: PathPlasticityService;
  readonly publishedEvents: EventLogEntry[];
  readonly repoUpdates: { pathId: string; updates: Partial<PathRelation> }[];
  readonly usageReader: {
    listRecentUsage: ReturnType<typeof vi.fn>;
    findDeliveredObjectIds: ReturnType<typeof vi.fn>;
    findDeliveredObjects: ReturnType<typeof vi.fn>;
  };
  readonly pathRepo: {
    findByAnchor: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  readonly getPath: (pathId: string) => Readonly<PathRelation> | undefined;
}

export function buildHarness(params: {
  readonly usageRecords: readonly UsageProofRecord[];
  readonly pathsByObjectId: Readonly<Record<string, readonly PathRelation[]>>;
  readonly deliveredObjectIdsByDeliveryId?: Readonly<Record<string, readonly string[]>>;
  readonly deliveredObjectsByDeliveryId?: Readonly<Record<string, readonly SoulContextObjectIdentity[]>>;
  readonly runtimeNotifier?: Partial<RuntimeNotifier>;
}): Harness {
  const publishedEvents: EventLogEntry[] = [];
  const repoUpdates: { pathId: string; updates: Partial<PathRelation> }[] = [];
  const pathStateById = new Map<string, PathRelation>();
  for (const path of Object.values(params.pathsByObjectId).flat()) {
    pathStateById.set(path.path_id, path);
  }

  let eventSavepointStart: number | null = null;
  let repoUpdateSavepointStart: number | null = null;
  let pathStateSavepoint: Map<string, PathRelation> | null = null;
  const buildEntry = (input: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry => {
    const revision = publishedEvents.filter(
      (row) => row.entity_type === input.entity_type && row.entity_id === input.entity_id
    ).length;
    return {
      ...input,
      revision,
      event_id: `evt-${publishedEvents.length + 1}`,
      created_at: NOW_ISO
    };
  };
  const eventLogRepo = {
    append: vi.fn((entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry => {
      const persisted = buildEntry(entry);
      publishedEvents.push(persisted);
      return persisted;
    }),
    deleteById: vi.fn((eventId: string): void => {
      const index = publishedEvents.findIndex((event) => event.event_id === eventId);
      if (index >= 0) {
        publishedEvents.splice(index, 1);
      }
    }),
    transactional: <T,>(fn: () => T): T => {
      eventSavepointStart = publishedEvents.length;
      repoUpdateSavepointStart = repoUpdates.length;
      pathStateSavepoint = new Map(pathStateById);
      try {
        const result = fn();
        eventSavepointStart = null;
        repoUpdateSavepointStart = null;
        pathStateSavepoint = null;
        return result;
      } catch (error) {
        if (eventSavepointStart !== null) {
          publishedEvents.splice(eventSavepointStart);
          eventSavepointStart = null;
        }
        if (repoUpdateSavepointStart !== null) {
          repoUpdates.splice(repoUpdateSavepointStart);
          repoUpdateSavepointStart = null;
        }
        if (pathStateSavepoint !== null) {
          pathStateById.clear();
          for (const [pathId, path] of pathStateSavepoint.entries()) {
            pathStateById.set(pathId, path);
          }
          pathStateSavepoint = null;
        }
        throw error;
      }
    },
    queryByEntity: vi.fn(async (_entityType: string, entityId: string): Promise<readonly EventLogEntry[]> => {
      return publishedEvents.filter((event) => event.entity_id === entityId);
    })
  };
  const runHotState = { apply: vi.fn(async () => undefined) };
  const runtimeNotifier: RuntimeNotifier = {
    notify: params.runtimeNotifier?.notify ?? vi.fn(() => undefined),
    notifyEntry: params.runtimeNotifier?.notifyEntry ?? vi.fn(() => undefined)
  };

  const eventPublisher = new EventPublisher({
    eventLogRepo,
    runHotStateService: runHotState,
    runtimeNotifier
  });

  const pathRepo: PathPlasticityRepoPort & {
    findByAnchor: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  } = {
    findByAnchor: vi.fn(async (_workspaceId: string, anchorRef) => {
      if (anchorRef.kind !== "object") {
        return [];
      }
      return (params.pathsByObjectId[anchorRef.object_id] ?? []).map(
        (path) => pathStateById.get(path.path_id) ?? path
      );
    }),
    update: vi.fn((pathId, updates) => {
      repoUpdates.push({ pathId, updates });
      const original = pathStateById.get(pathId) ?? createPath({ path_id: pathId });
      const updatedPath = {
        ...(original ?? createPath({ path_id: pathId })),
        ...(updates as Partial<PathRelation>),
        updated_at: updates.updated_at ?? NOW_ISO
      } as Readonly<PathRelation>;
      pathStateById.set(pathId, updatedPath as PathRelation);
      return updatedPath;
    })
  };

  const usageReader: UsageProofReaderPort & {
    listRecentUsage: ReturnType<typeof vi.fn>;
    findDeliveredObjectIds: ReturnType<typeof vi.fn>;
    findDeliveredObjects: ReturnType<typeof vi.fn>;
  } = {
    listRecentUsage: vi.fn(async () => params.usageRecords),
    findDeliveredObjectIds: vi.fn(async (deliveryId: string) => {
      return params.deliveredObjectIdsByDeliveryId?.[deliveryId] ?? null;
    }),
    findDeliveredObjects: vi.fn(async (deliveryId: string) => {
      return params.deliveredObjectsByDeliveryId?.[deliveryId] ?? null;
    })
  };

  const service = new PathPlasticityService({
    usageProofReader: usageReader,
    pathRelationRepo: pathRepo,
    eventPublisher,
    eventLogRepo,
    now: () => NOW_ISO
  });

  return {
    service,
    publishedEvents,
    repoUpdates,
    usageReader,
    pathRepo,
    getPath: (pathId) => pathStateById.get(pathId)
  };
}

