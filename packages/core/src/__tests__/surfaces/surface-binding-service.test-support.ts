import { vi } from "vitest";
import { BindingState, CrossCuttingState, type CrossCuttingPermission, type GovernanceDriftLease, type SurfaceBinding } from "@do-soul/alaya-protocol";
import { type SurfaceBindingServiceDependencies } from "../../surfaces/surface-binding-service.js";

export const BINDING_ID_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

export const BINDING_ID_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

export type BindingRecord = { readonly binding_id: string; readonly binding: SurfaceBinding };

export function createBinding(overrides: Partial<SurfaceBinding> = {}): SurfaceBinding {
  return {
    object_id: "claim://object-1",
    object_kind: "surface_binding",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-22T00:00:00.000Z",
    updated_at: "2026-03-22T00:00:00.000Z",
    created_by: "user",
    surface_id: "surface://main",
    is_primary: true,
    binding_state: BindingState.ACTIVE,
    workspace_id: "workspace-1",
    ...overrides
  };
}

export function createPermission(overrides: Partial<CrossCuttingPermission> = {}): CrossCuttingPermission {
  return {
    object_id: "claim://object-1",
    object_kind: "cross_cutting_permission",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-22T00:00:00.000Z",
    updated_at: "2026-03-22T00:00:00.000Z",
    created_by: "user",
    cross_cutting_state: CrossCuttingState.NONE,
    allowed_surfaces: [],
    workspace_id: "workspace-1",
    ...overrides
  };
}

export function createDriftLease(
  overrides: Partial<GovernanceDriftLease> = {}
): GovernanceDriftLease {
  return {
    lease_id: "drift-lease-1",
    workspace_id: "workspace-1",
    operation_type: "surface.bind_object",
    granted_to: "user",
    drift_id: null,
    expires_at: "2026-03-22T01:05:00.000Z",
    granted_at: "2026-03-22T01:00:00.000Z",
    ...overrides
  };
}

export function createDependencies(seed?: {
  readonly bindings?: readonly BindingRecord[];
  readonly permissions?: readonly {
    readonly permission_id: string;
    readonly permission: CrossCuttingPermission;
  }[];
}): {
  readonly dependencies: SurfaceBindingServiceDependencies;
  readonly order: string[];
  readonly publishedEvents: {
    readonly single: unknown[];
    readonly many: unknown[][];
  };
  readonly eventPublisher: {
    readonly appendManyWithMutation: ReturnType<typeof vi.fn>;
  };
  readonly warnSpy: ReturnType<typeof vi.fn>;
  readonly driftService: {
    readonly acquireLease: ReturnType<typeof vi.fn>;
    readonly releaseLease: ReturnType<typeof vi.fn>;
    readonly classifyDrift: ReturnType<typeof vi.fn>;
    readonly alertOnCriticalDrift: ReturnType<typeof vi.fn>;
  };
} {
  const bindingStore = new Map(
    (seed?.bindings ?? []).map((record) => [record.binding_id, Object.freeze({ ...record })])
  );
  const permissionStore = new Map(
    (seed?.permissions ?? []).map((record) => [record.permission_id, Object.freeze({ ...record })])
  );

  const order: string[] = [];
  const publishedEvents = {
    single: [] as unknown[],
    many: [] as unknown[][]
  };
  const warnSpy = vi.fn();
  const driftService = {
    acquireLease: vi.fn(async () => createDriftLease()),
    releaseLease: vi.fn(async () => {}),
    classifyDrift: vi.fn(async () => ({
      drift_id: "drift-1",
      workspace_id: "workspace-1",
      drift_type: "scope_change" as const,
      severity: "governance_critical" as const,
      affected_subject: "surface_governance::entity=binding",
      description: "Surface binding changed",
      detected_at: "2026-03-22T01:00:00.000Z"
    })),
    alertOnCriticalDrift: vi.fn(async () => ({
      alert_id: "alert-1",
      workspace_id: "workspace-1",
      drift_id: "drift-1",
      severity: "governance_critical" as const,
      message: "governance drift",
      alerted_at: "2026-03-22T01:00:00.000Z"
    }))
  };
  // Single fake appendManyWithMutation handles both 1-event and N-event
  // call sites: `single`/`many` buckets disambiguate them post-hoc by the
  // batch length so existing assertions keep working.
  const eventPublisher = {
    appendManyWithMutation: vi.fn(async (events: readonly any[], mutate: (entries: any[]) => any) => {
      if (events.length === 1) {
        order.push("event_publish");
        publishedEvents.single.push(events[0]);
      } else {
        order.push("event_publish_many");
        publishedEvents.many.push([...events]);
      }
      const persisted = events.map((event, idx) => ({
        ...event,
        event_id: `evt_${idx}`,
        created_at: "2026-03-22T01:00:00.000Z"
      }));
      const result = mutate(persisted);
      if (events.length === 1) {
        order.push("event_propagate");
      } else {
        order.push("event_propagate_many");
      }
      return result;
    })
  };

  const dependencies: SurfaceBindingServiceDependencies = {
    generateObjectId: (() => {
      const ids = [BINDING_ID_1, BINDING_ID_2];
      let cursor = seed?.bindings?.length ?? 0;
      return () => {
        const value = ids[cursor] ?? `generated-${cursor}`;
        cursor += 1;
        return value;
      };
    })(),
    now: () => "2026-03-22T01:00:00.000Z",
    surfaceBindingRepo: {
      create: vi.fn((binding, bindingId) => {
        order.push("binding_create");
        const record = Object.freeze({ binding_id: bindingId, binding: Object.freeze({ ...binding }) });
        bindingStore.set(bindingId, record);
        return record;
      }),
      findByBindingId: vi.fn(async (bindingId) => bindingStore.get(bindingId) ?? null),
      findByObjectId: vi.fn(async (objectId, workspaceId) =>
        [...bindingStore.values()].filter(
          (record) =>
            record.binding.object_id === objectId && record.binding.workspace_id === workspaceId
        )
      ),
      findPrimaryBinding: vi.fn(async (objectId, workspaceId) =>
        [...bindingStore.values()].find(
          (record) =>
            record.binding.object_id === objectId &&
            record.binding.workspace_id === workspaceId &&
            record.binding.is_primary &&
            record.binding.binding_state !== BindingState.DETACHED
        ) ?? null
      ),
      findBySurfaceId: vi.fn(async (surfaceId, workspaceId) =>
        [...bindingStore.values()].filter(
          (record) =>
            record.binding.surface_id === surfaceId &&
            record.binding.workspace_id === workspaceId
        )
      ),
      findDetachableBySurfaceId: vi.fn(async (surfaceId, workspaceId) =>
        [...bindingStore.values()].filter(
          (record) =>
            record.binding.surface_id === surfaceId &&
            record.binding.workspace_id === workspaceId &&
            record.binding.binding_state !== BindingState.DETACHED
        )
      ),
      findByWorkspace: vi.fn(async (workspaceId) =>
        [...bindingStore.values()].filter((record) => record.binding.workspace_id === workspaceId)
      ),
      updateState: vi.fn((bindingId, bindingState, updatedAt) => {
        order.push("binding_update");
        const existing = bindingStore.get(bindingId);

        if (existing === undefined) {
          throw new Error(`missing binding ${bindingId}`);
        }

        const updated = Object.freeze({
          binding_id: bindingId,
          binding: Object.freeze({
            ...existing.binding,
            binding_state: bindingState,
            updated_at: updatedAt
          })
        });
        bindingStore.set(bindingId, updated);
        return updated;
      }),
      cascadeDetachBySurfaceId: vi.fn((surfaceId, workspaceId, updatedAt) => {
        order.push("binding_cascade_detach");

        const detached: BindingRecord[] = [];

        for (const [bindingId, existing] of bindingStore.entries()) {
          if (
            existing.binding.surface_id === surfaceId &&
            existing.binding.workspace_id === workspaceId &&
            existing.binding.binding_state !== BindingState.DETACHED
          ) {
            const updated = Object.freeze({
              binding_id: bindingId,
              binding: Object.freeze({
                ...existing.binding,
                binding_state: BindingState.DETACHED,
                updated_at: updatedAt
              })
            });
            bindingStore.set(bindingId, updated);
            detached.push(updated);
          }
        }

        return detached;
      })
    },
    crossCuttingPermissionLookup: {
      findByObjectId: vi.fn(async (objectId, workspaceId) =>
        [...permissionStore.values()].find(
          (record) =>
            record.permission.object_id === objectId &&
            record.permission.workspace_id === workspaceId
        ) ?? null
      )
    },
    eventPublisher,
    surfaceDriftService: driftService,
    warn: warnSpy
  };

  return { dependencies, order, publishedEvents, eventPublisher, warnSpy, driftService };
}
