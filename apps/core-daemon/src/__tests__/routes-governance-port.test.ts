import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { VerificationVerdict } from "@do-soul/alaya-protocol";
import { registerGovernanceRoutes } from "../routes/governance.js";
import { registerGreenStatusRoutes } from "../routes/green-status.js";
import { registerOverrideRoutes } from "../routes/overrides.js";
import { registerSecurityStatusRoutes } from "../routes/security-status.js";
import { registerConflictMatrixRoutes } from "../routes/conflict-matrix.js";
import { registerBudgetRoutes } from "../routes/budget.js";
import { registerHealthJournalRoutes } from "../routes/health-journal.js";

describe("routes-governance port batch", () => {
  it("registerGovernanceRoutes aggregates services into governance snapshot", async () => {
    const app = new Hono();
    const services = {
      now: () => "2026-03-25T00:00:04.000Z",
      runService: {
        getById: vi.fn(async () => ({ run_id: "run-1", workspace_id: "ws-1" }))
      },
      greenService: {
        findAll: vi.fn(async () => [
          {
            target_object_id: "memory-1",
            green_state: "eligible",
            verification_basis: null,
            valid_until: null,
            revoke_reason: null,
            last_transition_at: "2026-03-25T00:00:01.000Z"
          }
        ])
      },
      sessionOverrideService: {
        getActiveFor: vi.fn(async () => [
          {
            runtime_id: "override-1",
            target_object: "memory-1",
            correction: "prefer deterministic output",
            priority: 1,
            expires_at: "2026-03-25T01:00:00.000Z"
          }
        ])
      },
      governanceLeaseService: {
        getActive: vi.fn(async () => ({
          lease_id: "lease-1",
          holder: "run:run-1:turn:turn-1",
          expires_at: "2026-03-25T01:00:00.000Z"
        }))
      }
    };
    registerGovernanceRoutes(app, services as any);

    const response = await app.request("/runs/run-1/governance-snapshot");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        run_id: "run-1",
        workspace_id: "ws-1",
        green_summary: {
          eligible_count: 1,
          grace_count: 0,
          revoked_count: 0
        },
        governance_lease: {
          held: true,
          lease_id: "lease-1",
          holder: "run:run-1:turn:turn-1"
        }
      }
    });
    expect(services.runService.getById).toHaveBeenCalledWith("run-1");
    expect(services.greenService.findAll).toHaveBeenCalledWith("ws-1");
    expect(services.sessionOverrideService.getActiveFor).toHaveBeenCalledWith("run-1");
    expect(services.governanceLeaseService.getActive).toHaveBeenCalledWith("run-1");
  });

  it("registerGreenStatusRoutes verifies green status via service call", async () => {
    const app = new Hono();
    const services = {
      workspaceService: { getById: vi.fn(async () => ({ workspace_id: "ws-1" })) },
      greenService: {
        findEligible: vi.fn(),
        findGrace: vi.fn(),
        getStatus: vi.fn(),
        runVerification: vi.fn(async () => ({ status: "updated" }))
      }
    };
    registerGreenStatusRoutes(app, services as any);

    const response = await app.request("/workspaces/ws-1/green-statuses/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        target_object_id: "memory-1",
        verdict: VerificationVerdict.GO
      })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: { status: "updated" }
    });
    expect(services.greenService.runVerification).toHaveBeenCalledWith({
      targetObjectId: "memory-1",
      workspaceId: "ws-1",
      verdict: VerificationVerdict.GO,
      microCorrectionHint: null,
      necessaryPatch: null
    });
  });

  it("registerOverrideRoutes validates override body and delegates apply", async () => {
    const app = new Hono();
    const services = {
      runService: { getById: vi.fn(async () => ({ run_id: "run-1", workspace_id: "ws-1" })) },
      sessionOverrideService: {
        apply: vi.fn(async () => ({ runtime_id: "override-1", target_object: "memory-1" }))
      }
    };
    registerOverrideRoutes(app, services as any);

    const response = await app.request("/runs/run-1/overrides", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        target_object: "memory-1",
        correction: "prefer concise answers",
        priority: 2
      })
    });

    expect(response.status).toBe(201);
    expect(services.sessionOverrideService.apply).toHaveBeenCalledWith({
      runId: "run-1",
      workspaceId: "ws-1",
      targetObject: "memory-1",
      correction: "prefer concise answers",
      priority: 2
    });
  });

  it("registerSecurityStatusRoutes returns security status for workspace", async () => {
    const app = new Hono();
    const services = {
      workspaceService: { getById: vi.fn(async () => ({ workspace_id: "ws-1" })) },
      securityStatusService: { getStatus: vi.fn(async () => ({ enforcement_mode: "enforced" })) }
    };
    registerSecurityStatusRoutes(app, services as any);

    const response = await app.request("/workspaces/ws-1/security-status");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: { enforcement_mode: "enforced" }
    });
    expect(services.securityStatusService.getStatus).toHaveBeenCalledWith("ws-1");
  });

  it("registerConflictMatrixRoutes creates conflict edges through arbitration service", async () => {
    const app = new Hono();
    const services = {
      workspaceService: { getById: vi.fn(async () => ({ workspace_id: "ws-1" })) },
      arbitrationService: {
        listEdgesByWorkspace: vi.fn(),
        createEdge: vi.fn(async () => ({ object_id: "edge-1" })),
        deleteEdge: vi.fn(),
        rebuildConflictMatrix: vi.fn()
      }
    };
    registerConflictMatrixRoutes(app, services as any);

    const response = await app.request("/conflict-matrix-edges", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source_claim_id: "claim-a",
        target_claim_id: "claim-b",
        edge_type: "supports"
      })
    });

    expect(response.status).toBe(201);
    expect(services.arbitrationService.createEdge).toHaveBeenCalledWith({
      source_claim_id: "claim-a",
      target_claim_id: "claim-b",
      edge_type: "supports",
      created_by: "user_action"
    });
  });

  it("registerBudgetRoutes snapshots and resolves bankruptcy proposals", async () => {
    const app = new Hono();
    const services = {
      now: () => "2026-03-25T00:00:00.000Z",
      runService: { getById: vi.fn(async () => ({ run_id: "run-1", workspace_id: "ws-1" })) },
      budgetBankruptcyService: {
        getSnapshot: vi.fn(async () => ({ mode: "normal" })),
        resolve: vi.fn(async () => ({ proposal_id: "proposal-1" }))
      }
    };
    registerBudgetRoutes(app, services as any);

    const snapshotResponse = await app.request("/runs/run-1/budget-snapshot");
    expect(snapshotResponse.status).toBe(200);
    expect(services.budgetBankruptcyService.getSnapshot).toHaveBeenCalledWith("run-1", "2026-03-25T00:00:00.000Z");

    const resolveResponse = await app.request("/runs/run-1/budget-bankruptcy/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        option_id: "option-1",
        action: "accept"
      })
    });

    expect(resolveResponse.status).toBe(200);
    expect(services.budgetBankruptcyService.resolve).toHaveBeenCalledWith({
      runId: "run-1",
      workspaceId: "ws-1",
      optionId: "option-1",
      action: "accept"
    });
  });

  it("registerHealthJournalRoutes parses filters and passes limit/kind", async () => {
    const app = new Hono();
    const services = {
      workspaceService: { getById: vi.fn(async () => ({ workspace_id: "ws-1" })) },
      healthJournalService: { getRecentEvents: vi.fn(async () => [{ entry_id: "h1" }]) }
    };
    registerHealthJournalRoutes(app, services as any);

    const response = await app.request("/workspaces/ws-1/health-journal?kind=pointer_failure&limit=10");
    expect(response.status).toBe(200);
    expect(services.healthJournalService.getRecentEvents).toHaveBeenCalledWith("ws-1", {
      kind: "pointer_failure",
      limit: 10
    });
  });
});
