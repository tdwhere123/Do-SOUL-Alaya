import {
  RuntimeGovernanceEventType,
  WorkerBaselineLockSchema,
  SecurityStatusContractSchema,
  parseRuntimeGovernanceEventPayload,
  ZeroDayPolicySchema,
  type EventLogEntry,
  type SecurityStatusContract,
  type ZeroDayPolicy
} from "@do-soul/alaya-protocol";
import { describe, expect, it, vi } from "vitest";
import { SecurityStatusService } from "../../security/security-status-service.js";
import { ZeroDaySecurityLayer } from "../../security/zero-day-security-layer.js";

const FIXED_NOW = "2026-04-15T08:00:00.000Z";

describe("SecurityStatusService", () => {
  it("returns a surface-consumable status contract for the workspace", async () => {
    const publish = vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
      ...entry,
      event_id: "event-1",
      created_at: FIXED_NOW,
          revision: 0
    }));
    const service = new SecurityStatusService({
      zeroDayLayer: new ZeroDaySecurityLayer({
        loadPolicies: async () => [],
        now: () => FIXED_NOW
      }),
      eventPublisher: { publish }
    });

    const status = await service.getStatus("workspace-1");

    expect(SecurityStatusContractSchema.parse(status)).toEqual(status);
    expect(status).toMatchObject({
      workspace_id: "workspace-1",
      posture: "baseline",
      zero_day_active: false,
      active_security_locks: 0
    });
    expect(publish).not.toHaveBeenCalled();
  });

  it("publishes security.passthrough_status_changed when the workspace posture changes", async () => {
    const publishedEvents: Array<Omit<EventLogEntry, "event_id" | "created_at" | "revision">> = [];
    const service = new SecurityStatusService({
      zeroDayLayer: new ZeroDaySecurityLayer({
        loadPolicies: async () => [],
        now: () => FIXED_NOW
      }),
      eventPublisher: {
        publish: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => {
          publishedEvents.push(entry);
          return {
            ...entry,
            event_id: `event-${publishedEvents.length}`,
            created_at: FIXED_NOW,
            revision: publishedEvents.length
          };
        })
      }
    });

    await service.emitStatusChange("workspace-1", "policy_refreshed");

    expect(publishedEvents).toHaveLength(1);
    expect(publishedEvents[0]).toMatchObject({
      event_type: RuntimeGovernanceEventType.SECURITY_PASSTHROUGH_STATUS_CHANGED,
      entity_type: "workspace",
      entity_id: "workspace-1",
      workspace_id: "workspace-1",
      run_id: null,
      caused_by: "system"
    });
    expect(
      parseRuntimeGovernanceEventPayload(
        RuntimeGovernanceEventType.SECURITY_PASSTHROUGH_STATUS_CHANGED,
        publishedEvents[0]!.payload_json
      )
    ).toEqual({
      workspace_id: "workspace-1",
      posture: "baseline",
      zero_day_active: false,
      active_security_locks: 0,
      reason: "policy_refreshed",
      changed_at: FIXED_NOW
    });
  });

  it("emits a new status when zero-day policy reevaluation observes a posture change", async () => {
    let policies: readonly ZeroDayPolicy[] = [];
    let now = FIXED_NOW;
    const publishedEvents: Array<Omit<EventLogEntry, "event_id" | "created_at" | "revision">> = [];
    const zeroDayLayer = new ZeroDaySecurityLayer({
      loadPolicies: async () => policies,
      now: () => now,
      policyEvaluationCacheTtlMs: 50
    });
    const service = new SecurityStatusService({
      zeroDayLayer,
      eventPublisher: {
        publish: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => {
          publishedEvents.push(entry);
          return {
            ...entry,
            event_id: `event-${publishedEvents.length}`,
            created_at: FIXED_NOW,
            revision: publishedEvents.length
          };
        })
      }
    });

    await service.initializeWorkspace("workspace-1");
    expect(publishedEvents).toHaveLength(1);

    policies = [
      ZeroDayPolicySchema.parse({
        policy_id: "policy-hard-stop",
        kind: "hard_stop",
        target: "operator-stop",
        reason: "lock everything down",
        effective_at: "2026-04-15T08:00:00.000Z",
        expires_at: null
      })
    ];
    now = "2026-04-15T08:00:00.051Z";

    await zeroDayLayer.augmentLock(
      WorkerBaselineLockSchema.parse({
        lock_id: "lock-1",
        workspace_id: "workspace-1",
        hard_constraint_refs: [],
        denied_tool_categories: [],
        hazard_object_refs: [],
        hard_stop_refs: [],
        assembled_at: FIXED_NOW
      })
    );

    expect(publishedEvents).toHaveLength(2);
    expect(
      parseRuntimeGovernanceEventPayload(
        RuntimeGovernanceEventType.SECURITY_PASSTHROUGH_STATUS_CHANGED,
        publishedEvents[1]!.payload_json
      )
    ).toEqual({
      workspace_id: "workspace-1",
      posture: "locked_down",
      zero_day_active: true,
      active_security_locks: 1,
      reason: "worker.baseline_evaluated",
      changed_at: "2026-04-15T08:00:00.051Z"
    });
  });

  it("initializes workspace baseline security only once and emits the initial posture once", async () => {
    const publish = vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
      ...entry,
      event_id: "event-1",
      created_at: FIXED_NOW,
          revision: 0
    }));
    const service = new SecurityStatusService({
      zeroDayLayer: new ZeroDaySecurityLayer({
        loadPolicies: async () => [],
        now: () => FIXED_NOW
      }),
      eventPublisher: { publish }
    });

    await service.initializeWorkspace("workspace-1");
    await service.initializeWorkspace("workspace-1");

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: RuntimeGovernanceEventType.SECURITY_PASSTHROUGH_STATUS_CHANGED,
        payload_json: expect.objectContaining({
          workspace_id: "workspace-1",
          reason: "workspace_initialized"
        })
      })
    );
  });

  it("does not re-emit workspace_initialized after initialization tracking expires", async () => {
    let now = FIXED_NOW;
    const publish = vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
      ...entry,
      event_id: "event-1",
      created_at: FIXED_NOW,
          revision: 0
    }));
    const service = new SecurityStatusService({
      zeroDayLayer: new ZeroDaySecurityLayer({
        loadPolicies: async () => [],
        now: () => now,
        initializedWorkspaceCacheTtlMs: 50
      }),
      eventPublisher: { publish }
    });

    await service.initializeWorkspace("workspace-1");
    now = "2026-04-15T08:00:00.051Z";
    await service.initializeWorkspace("workspace-1");

    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("does not re-emit when active protections reorder without semantic change", async () => {
    let status = SecurityStatusContractSchema.parse({
      workspace_id: "workspace-1",
      posture: "configured",
      zero_day_active: true,
      active_security_locks: 2,
      last_assessment_at: FIXED_NOW,
      active_protections: ["deny category: write", "deny tool: tools.exec_shell"]
    });
    let observer: ((status: SecurityStatusContract, reason: string) => Promise<void> | void) | undefined;
    const unsubscribe = vi.fn();
    const publish = vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
      ...entry,
      event_id: "event-1",
      created_at: FIXED_NOW,
          revision: 0
    }));
    const service = new SecurityStatusService({
      zeroDayLayer: {
        getSecurityStatus: vi.fn(async () => status),
        initializeWorkspaceSecurity: vi.fn(async () => true),
        subscribeStatusEvaluations: vi.fn((candidate) => {
          observer = candidate;
          return unsubscribe;
        })
      },
      eventPublisher: { publish }
    });

    await service.initializeWorkspace("workspace-1");
    status = SecurityStatusContractSchema.parse({
      ...status,
      last_assessment_at: "2026-04-15T08:00:00.050Z",
      active_protections: ["deny tool: tools.exec_shell", "deny category: write"]
    });
    await observer?.(status, "policy_reordered");

    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("publishes a bootstrap failure witness with optional diagnostics when workspace security initialization fails", async () => {
    const publishedEvents: Array<Omit<EventLogEntry, "event_id" | "created_at" | "revision">> = [];
    const service = new SecurityStatusService({
      zeroDayLayer: new ZeroDaySecurityLayer({
        loadPolicies: async () => [],
        now: () => FIXED_NOW
      }),
      eventPublisher: {
        publish: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => {
          publishedEvents.push(entry);
          return {
            ...entry,
            event_id: `event-${publishedEvents.length}`,
            created_at: FIXED_NOW,
            revision: publishedEvents.length
          };
        })
      }
    });

    await (
      service as {
        recordInitializationFailure(
          workspaceId: string,
          operation: "create" | "list" | "get_by_id",
          reason?: string | null,
          errorCode?: string | null
        ): Promise<void>;
      }
    ).recordInitializationFailure(
      "workspace-1",
      "create",
      "Zero-day policy store is offline",
      "SyntaxError"
    );

    expect(publishedEvents).toEqual([
      expect.objectContaining({
        event_type: RuntimeGovernanceEventType.SECURITY_PASSTHROUGH_INITIALIZATION_FAILED,
        entity_type: "workspace",
        entity_id: "workspace-1",
        workspace_id: "workspace-1",
        run_id: null,
        caused_by: "system",
        payload_json: {
          workspace_id: "workspace-1",
          operation: "create",
          failed_at: FIXED_NOW,
          reason: "Zero-day policy store is offline",
          error_code: "SyntaxError"
        }
      })
    ]);
  });

  it("records a degraded epoch timestamp, not a fresh now, when the status probe read fails", async () => {
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const publishedEvents: Array<Omit<EventLogEntry, "event_id" | "created_at" | "revision">> = [];
    const service = new SecurityStatusService({
      zeroDayLayer: {
        getSecurityStatus: vi.fn(async () => {
          throw new Error("zero-day status store offline");
        }),
        initializeWorkspaceSecurity: vi.fn(async () => false),
        subscribeStatusEvaluations: vi.fn(() => vi.fn())
      },
      eventPublisher: {
        publish: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => {
          publishedEvents.push(entry);
          return { ...entry, event_id: "event-1", created_at: FIXED_NOW, revision: 0 };
        })
      }
    });

    await (
      service as {
        recordInitializationFailure(
          workspaceId: string,
          operation: "create" | "list" | "get_by_id",
          reason?: string | null,
          errorCode?: string | null
        ): Promise<void>;
      }
    ).recordInitializationFailure("workspace-1", "create", "init failed", "Error");

    expect(publishedEvents).toHaveLength(1);
    expect(publishedEvents[0]!.payload_json).toMatchObject({
      failed_at: new Date(0).toISOString()
    });
    expect(emitWarning).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ code: "ALAYA_SECURITY_STATUS_READ_FAILED" })
    );
    emitWarning.mockRestore();
  });

  it("unsubscribes from zero-day evaluations when closed", () => {
    const unsubscribe = vi.fn();
    const subscribeStatusEvaluations = vi.fn(() => unsubscribe);
    const service = new SecurityStatusService({
      zeroDayLayer: {
        getSecurityStatus: vi.fn(async () =>
          SecurityStatusContractSchema.parse({
            workspace_id: "workspace-1",
            posture: "baseline",
            zero_day_active: false,
            active_security_locks: 0,
            last_assessment_at: FIXED_NOW,
            active_protections: []
          })
        ),
        initializeWorkspaceSecurity: vi.fn(async () => false),
        subscribeStatusEvaluations
      },
      eventPublisher: {
        publish: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
          ...entry,
          event_id: "event-1",
          created_at: FIXED_NOW,
          revision: 0
        }))
      }
    });

    service.close();

    expect(subscribeStatusEvaluations).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("bounds observed status cache, refreshes matching workspaces, and clears on close", async () => {
    let observer: ((status: SecurityStatusContract, reason: string) => Promise<void> | void) | undefined;
    const unsubscribe = vi.fn();
    const publish = vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
      ...entry,
      event_id: "event-1",
      created_at: FIXED_NOW,
      revision: 0
    }));
    const service = new SecurityStatusService({
      zeroDayLayer: {
        getSecurityStatus: vi.fn(async (workspaceId: string) =>
          createSecurityStatus(workspaceId)
        ),
        initializeWorkspaceSecurity: vi.fn(async () => false),
        subscribeStatusEvaluations: vi.fn((candidate) => {
          observer = candidate;
          return unsubscribe;
        })
      },
      eventPublisher: { publish },
      observedStatusCacheLimit: 2
    });
    const cacheView = service as unknown as {
      readonly observedStatuses: ReadonlyMap<string, unknown>;
    };

    await observer?.(createSecurityStatus("workspace-1"), "evaluated");
    await observer?.(createSecurityStatus("workspace-2"), "evaluated");
    await observer?.(createSecurityStatus("workspace-1"), "same_status_refresh");
    await observer?.(createSecurityStatus("workspace-3"), "evaluated");

    expect(publish).toHaveBeenCalledTimes(3);
    expect([...cacheView.observedStatuses.keys()]).toEqual([
      "workspace-1",
      "workspace-3"
    ]);

    service.close();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect([...cacheView.observedStatuses.keys()]).toEqual([]);
  });
});

function createSecurityStatus(workspaceId: string): SecurityStatusContract {
  return SecurityStatusContractSchema.parse({
    workspace_id: workspaceId,
    posture: "baseline",
    zero_day_active: false,
    active_security_locks: 0,
    last_assessment_at: FIXED_NOW,
    active_protections: []
  });
}
