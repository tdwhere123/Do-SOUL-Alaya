import {
  SecurityStatusContractSchema,
  WorkerBaselineLockSchema,
  ZeroDayPolicySchema,
  type WorkerBaselineLock,
  type ZeroDayPolicy
} from "@do-soul/alaya-protocol";
import { describe, expect, it, vi } from "vitest";
import { ZeroDaySecurityLayer } from "../../../governance/security/zero-day-security-layer.js";

function createLock(overrides: Partial<WorkerBaselineLock> = {}): WorkerBaselineLock {
  return WorkerBaselineLockSchema.parse({
    lock_id: "lock-1",
    workspace_id: "workspace-1",
    hard_constraint_refs: ["claim-1"],
    denied_tool_categories: ["network"],
    hazard_object_refs: ["hazard-1"],
    hard_stop_refs: ["hard-stop-1"],
    assembled_at: "2026-04-14T00:00:00.000Z",
    ...overrides
  });
}

function createPolicy(overrides: Partial<ZeroDayPolicy> = {}): ZeroDayPolicy {
  return ZeroDayPolicySchema.parse({
    policy_id: "policy-1",
    kind: "deny_category",
    target: "write",
    reason: "emergency write lockdown",
    effective_at: "2026-04-14T00:00:00.000Z",
    expires_at: "2026-04-15T00:00:00.000Z",
    ...overrides
  });
}

describe("ZeroDaySecurityLayer", () => {
  it("returns the same lock object when no active policy applies", async () => {
    const lock = createLock();
    const layer = new ZeroDaySecurityLayer({
      loadPolicies: async () => [
        createPolicy({
          policy_id: "policy-future",
          effective_at: "2026-04-16T00:00:00.000Z",
          expires_at: "2026-04-17T00:00:00.000Z"
        })
      ],
      now: () => "2026-04-14T12:00:00.000Z"
    });

    const result = await layer.augmentLock(lock);

    expect(result).toBe(lock);
  });

  it("adds an active deny_category policy to denied_tool_categories", async () => {
    const layer = new ZeroDaySecurityLayer({
      loadPolicies: async () => [createPolicy()],
      now: () => "2026-04-14T12:00:00.000Z"
    });

    const result = await layer.augmentLock(createLock());

    expect(result.denied_tool_categories).toEqual(["network", "write"]);
    expect(WorkerBaselineLockSchema.parse(result)).toEqual(result);
  });

  it("adds an active hard_stop policy to hard_stop_refs", async () => {
    const layer = new ZeroDaySecurityLayer({
      loadPolicies: async () => [
        createPolicy({
          policy_id: "policy-hard-stop",
          kind: "hard_stop",
          target: "operator-stop",
          expires_at: null
        })
      ],
      now: () => "2026-04-14T12:00:00.000Z"
    });

    const result = await layer.augmentLock(createLock());

    expect(result.hard_stop_refs).toEqual(["hard-stop-1", "policy-hard-stop"]);
  });

  it("excludes expired policies and policies that are not active yet", async () => {
    const layer = new ZeroDaySecurityLayer({
      loadPolicies: async () => [
        createPolicy({
          policy_id: "policy-expired",
          kind: "deny_category",
          target: "exec",
          expires_at: "2026-04-14T01:00:00.000Z"
        }),
        createPolicy({
          policy_id: "policy-future",
          kind: "deny_category",
          target: "memory",
          effective_at: "2026-04-15T00:00:00.000Z",
          expires_at: "2026-04-16T00:00:00.000Z"
        })
      ],
      now: () => "2026-04-14T12:00:00.000Z"
    });

    const result = await layer.augmentLock(createLock());

    expect(result).toEqual(createLock());
  });

  it("treats effective_at equal to now as active and expires_at equal to now as inactive", async () => {
    const layer = new ZeroDaySecurityLayer({
      loadPolicies: async () => [
        createPolicy({
          policy_id: "policy-active-at-boundary",
          kind: "deny_category",
          target: "write",
          effective_at: "2026-04-14T12:00:00.000Z"
        }),
        createPolicy({
          policy_id: "policy-expired-at-boundary",
          kind: "hard_stop",
          target: "operator-stop",
          effective_at: "2026-04-14T00:00:00.000Z",
          expires_at: "2026-04-14T12:00:00.000Z"
        })
      ],
      now: () => "2026-04-14T12:00:00.000Z"
    });

    const result = await layer.augmentLock(createLock());

    expect(result.denied_tool_categories).toEqual(["network", "write"]);
    expect(result.hard_stop_refs).toEqual(["hard-stop-1"]);
  });

  it("deduplicates repeated category and hard-stop additions", async () => {
    const layer = new ZeroDaySecurityLayer({
      loadPolicies: async () => [
        createPolicy(),
        createPolicy({
          policy_id: "policy-write-duplicate",
          kind: "deny_category",
          target: "write"
        }),
        createPolicy({
          policy_id: "policy-hard-stop",
          kind: "hard_stop",
          target: "operator-stop"
        }),
        createPolicy({
          policy_id: "policy-hard-stop",
          kind: "hard_stop",
          target: "operator-stop"
        })
      ],
      now: () => "2026-04-14T12:00:00.000Z"
    });

    const result = await layer.augmentLock(createLock());

    expect(result.denied_tool_categories).toEqual(["network", "write"]);
    expect(result.hard_stop_refs).toEqual(["hard-stop-1", "policy-hard-stop"]);
  });

  it("reports baseline workspace security status when no active zero-day policy exists", async () => {
    const layer = new ZeroDaySecurityLayer({
      loadPolicies: async () => [],
      now: () => "2026-04-14T12:00:00.000Z"
    });

    const status = await layer.getSecurityStatus("workspace-1");

    expect(SecurityStatusContractSchema.parse(status)).toEqual(status);
    expect(status).toEqual({
      workspace_id: "workspace-1",
      posture: "baseline",
      zero_day_active: false,
      active_security_locks: 0,
      last_assessment_at: "2026-04-14T12:00:00.000Z",
      active_protections: []
    });
  });

  it("expires the policy evaluation cache according to the same clock used for policy evaluation", async () => {
    const loadPolicies = vi.fn(async () => [createPolicy()]);
    let now = "2026-04-14T12:00:00.000Z";
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(0);
    const layer = new ZeroDaySecurityLayer({
      loadPolicies,
      now: () => now,
      policyEvaluationCacheTtlMs: 100
    });

    try {
      await layer.getSecurityStatus("workspace-1");
      await layer.augmentLock(createLock());
      await layer.getSecurityStatus("workspace-1");

      expect(loadPolicies).toHaveBeenCalledTimes(1);

      now = "2026-04-14T12:00:00.101Z";
      await layer.getSecurityStatus("workspace-1");

      expect(loadPolicies).toHaveBeenCalledTimes(2);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("evaluates sub-second policy activation and expiry transitions against the live clock within the cache window", async () => {
    const loadPolicies = vi.fn(async () => [
      createPolicy({
        policy_id: "policy-subsecond-tool",
        kind: "deny_tool",
        target: "tools.exec_shell",
        effective_at: "2026-04-14T12:00:00.200Z",
        expires_at: "2026-04-14T12:00:00.600Z"
      })
    ]);
    let now = "2026-04-14T12:00:00.000Z";
    const layer = new ZeroDaySecurityLayer({
      loadPolicies,
      now: () => now,
      policyEvaluationCacheTtlMs: 1_000
    });

    // t = 0ms: not yet active
    const beforeActivation = await layer.getSecurityStatus("workspace-1");
    expect(beforeActivation.posture).toBe("baseline");
    expect(beforeActivation.zero_day_active).toBe(false);
    expect(beforeActivation.last_assessment_at).toBe("2026-04-14T12:00:00.000Z");
    await expect(layer.enforceToolAccess("workspace-1", "tools.exec_shell")).resolves.toBeUndefined();

    // t = 250ms: within 1,000ms cache TTL, policy is now active
    now = "2026-04-14T12:00:00.250Z";
    const whileActive = await layer.getSecurityStatus("workspace-1");
    expect(whileActive.posture).toBe("elevated");
    expect(whileActive.zero_day_active).toBe(true);
    expect(whileActive.last_assessment_at).toBe("2026-04-14T12:00:00.250Z");
    await expect(layer.enforceToolAccess("workspace-1", "tools.exec_shell")).rejects.toMatchObject({
      code: "VALIDATION"
    });

    // t = 600ms: within 1,000ms cache TTL, policy has reached expires_at and is inactive again
    now = "2026-04-14T12:00:00.600Z";
    const afterExpiry = await layer.getSecurityStatus("workspace-1");
    expect(afterExpiry.posture).toBe("baseline");
    expect(afterExpiry.zero_day_active).toBe(false);
    expect(afterExpiry.last_assessment_at).toBe("2026-04-14T12:00:00.600Z");
    await expect(layer.enforceToolAccess("workspace-1", "tools.exec_shell")).resolves.toBeUndefined();

    expect(loadPolicies).toHaveBeenCalledTimes(1);
  });

  it("summarizes active passthrough policies and only initializes a workspace once", async () => {
    const layer = new ZeroDaySecurityLayer({
      loadPolicies: async () => [
        createPolicy({
          policy_id: "policy-configured",
          kind: "deny_category",
          target: "write",
          reason: "restrict file writes"
        }),
        createPolicy({
          policy_id: "policy-elevated",
          kind: "deny_tool",
          target: "tools.exec_shell",
          reason: "hold shell access"
        }),
        createPolicy({
          policy_id: "policy-locked",
          kind: "hard_stop",
          target: "operator-stop",
          reason: "full lockdown",
          expires_at: null
        })
      ],
      now: () => "2026-04-14T12:00:00.000Z"
    });

    expect(await layer.initializeWorkspaceSecurity("workspace-1")).toBe(true);
    expect(await layer.initializeWorkspaceSecurity("workspace-1")).toBe(false);

    const status = await layer.getSecurityStatus("workspace-1");

    expect(SecurityStatusContractSchema.parse(status)).toEqual(status);
    expect(status).toEqual({
      workspace_id: "workspace-1",
      posture: "locked_down",
      zero_day_active: true,
      active_security_locks: 3,
      last_assessment_at: "2026-04-14T12:00:00.000Z",
      active_protections: [
        "deny category: write",
        "deny tool: tools.exec_shell",
        "hard stop: operator-stop"
      ]
    });
  });

  it("expires initialized workspace tracking to avoid unbounded retention", async () => {
    let now = "2026-04-14T12:00:00.000Z";
    const layer = new ZeroDaySecurityLayer({
      loadPolicies: async () => [],
      now: () => now,
      initializedWorkspaceCacheTtlMs: 50
    });

    expect(await layer.initializeWorkspaceSecurity("workspace-1")).toBe(true);
    expect(await layer.initializeWorkspaceSecurity("workspace-1")).toBe(false);

    now = "2026-04-14T12:00:00.051Z";
    expect(await layer.initializeWorkspaceSecurity("workspace-1")).toBe(true);
  });

  it("evicts the soonest-expiring initialized workspace entry instead of the oldest insertion", async () => {
    let now = "2026-04-14T12:00:00.100Z";
    const layer = new ZeroDaySecurityLayer({
      loadPolicies: async () => [],
      now: () => now,
      initializedWorkspaceCacheTtlMs: 100,
      initializedWorkspaceCacheMaxEntries: 1
    });

    expect(await layer.initializeWorkspaceSecurity("workspace-longer-lived")).toBe(true);

    now = "2026-04-14T12:00:00.000Z";
    expect(await layer.initializeWorkspaceSecurity("workspace-sooner-expiring")).toBe(true);

    now = "2026-04-14T12:00:00.050Z";
    expect(await layer.initializeWorkspaceSecurity("workspace-longer-lived")).toBe(false);
    expect(await layer.initializeWorkspaceSecurity("workspace-sooner-expiring")).toBe(true);
  });

  it("fails closed when an active deny_tool policy is present", async () => {
    const layer = new ZeroDaySecurityLayer({
      loadPolicies: async () => [
        createPolicy(),
        createPolicy({
          policy_id: "policy-deny-tool",
          kind: "deny_tool",
          target: "tools.exec_shell"
        }),
        createPolicy({
          policy_id: "policy-hard-stop",
          kind: "hard_stop",
          target: "operator-stop",
          expires_at: null
        })
      ],
      now: () => "2026-04-14T12:00:00.000Z"
    });

    await expect(layer.augmentLock(createLock())).rejects.toMatchObject({
      code: "VALIDATION",
      message: "Active zero-day deny_tool policies are not enforceable by WorkerBaselineLock."
    });
  });

  it("fails closed when the loader returns malformed policies", async () => {
    const layer = new ZeroDaySecurityLayer({
      loadPolicies: async () =>
        [
          {
            policy_id: "policy-bad-kind",
            kind: "deny_workspace",
            target: "write",
            reason: "bad kind",
            effective_at: "2026-04-14T00:00:00.000Z",
            expires_at: null
          }
        ] as unknown as readonly ZeroDayPolicy[],
      now: () => "2026-04-14T12:00:00.000Z"
    });

    await expect(layer.augmentLock(createLock())).rejects.toMatchObject({
      code: "VALIDATION"
    });
  });

  it("fails closed when the layer clock returns an invalid timestamp", async () => {
    const layer = new ZeroDaySecurityLayer({
      loadPolicies: async () => [createPolicy()],
      now: () => "not-a-timestamp"
    });

    await expect(layer.augmentLock(createLock())).rejects.toMatchObject({
      code: "VALIDATION"
    });
  });

  it("evaluates active policies using the live clock read after loadPolicies completes", async () => {
    let now = "2026-04-14T11:59:59.900Z";
    const layer = new ZeroDaySecurityLayer({
      loadPolicies: async () => {
        now = "2026-04-14T12:00:00.000Z";
        return [
          createPolicy({
            policy_id: "policy-boundary-cross",
            kind: "deny_tool",
            target: "tools.exec_shell",
            effective_at: "2026-04-14T12:00:00.000Z",
            expires_at: "2026-04-14T13:00:00.000Z"
          })
        ];
      },
      now: () => now
    });

    const status = await layer.getSecurityStatus("workspace-1");
    expect(status.zero_day_active).toBe(true);
    expect(status.posture).toBe("elevated");
    expect(status.last_assessment_at).toBe("2026-04-14T12:00:00.000Z");
    await expect(layer.enforceToolAccess("workspace-1", "tools.exec_shell")).rejects.toMatchObject({
      code: "VALIDATION"
    });
  });
});
