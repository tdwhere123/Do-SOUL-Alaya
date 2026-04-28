import { describe, expect, it, vi } from "vitest";
import { ControlPlaneObjectKind, RetentionPolicy } from "@do-what/protocol";
import { CoreError } from "@do-what/core";
import { createApp } from "../app.js";
import {
  createNoopConversationService,
  createStubEngineBindingService,
  createUnusedClaimService,
  createUnusedEvidenceService,
  createUnusedMemoryService,
  createUnusedProposalService,
  createUnusedSignalService,
  createUnusedSlotService,
  createUnusedSynthesisService
} from "./helpers/mock-services.js";

describe("governance routes", () => {
  it("returns an aggregated governance snapshot for a run", async () => {
    const greenStatuses = [
      createGreenStatus({
        target_object_id: "memory:revoked",
        green_state: "revoked",
        revoke_reason: "security_hit",
        last_transition_at: "2026-03-25T00:00:03.000Z"
      }),
      createGreenStatus({
        target_object_id: "memory:eligible",
        green_state: "eligible",
        last_transition_at: "2026-03-25T00:00:02.000Z"
      }),
      createGreenStatus({
        target_object_id: "memory:grace",
        green_state: "grace",
        last_transition_at: "2026-03-25T00:00:01.000Z"
      })
    ];
    const greenService = {
      findAll: vi.fn(async () => greenStatuses)
    };
    const sessionOverrideService = {
      getActiveFor: vi.fn(async () => [
        {
          runtime_id: "11111111-1111-4111-8111-111111111111",
          object_kind: "session_override",
          task_surface_ref: null,
          expires_at: "2026-03-25T01:00:00.000Z",
          derived_from: null,
          retention_policy: RetentionPolicy.SESSION_ONLY,
          scope: "session_only",
          target_object: "memory:style",
          correction: "Prefer pnpm",
          priority: 2
        }
      ])
    };
    const governanceLeaseService = {
      getActive: vi.fn(async () => ({
        runtime_id: "22222222-2222-4222-8222-222222222222",
        object_kind: ControlPlaneObjectKind.GOVERNANCE_LEASE,
        task_surface_ref: null,
        expires_at: "2026-03-25T00:05:00.000Z",
        derived_from: null,
        retention_policy: RetentionPolicy.SESSION_ONLY,
        lease_id: "22222222-2222-4222-8222-222222222222",
        holder: "run:run-1:turn:turn-1",
        piercing_conditions: []
      }))
    };
    const { app, runService } = createGovernanceApp({
      greenService,
      sessionOverrideService,
      governanceLeaseService,
      now: () => "2026-03-25T00:00:04.000Z"
    });

    const response = await app.request("/runs/run-1/governance-snapshot");
    const body = (await response.json()) as {
      readonly success: true;
      readonly data: {
        readonly green_statuses: readonly { readonly target_object_id: string }[];
      };
    };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      data: {
        run_id: "run-1",
        workspace_id: "workspace-1",
        green_summary: {
          eligible_count: 1,
          grace_count: 1,
          revoked_count: 1
        },
        green_statuses: [
          expect.objectContaining({
            target_object_id: "memory:revoked",
            green_state: "revoked",
            revoke_reason: "security_hit"
          }),
          expect.objectContaining({
            target_object_id: "memory:eligible",
            green_state: "eligible"
          }),
          expect.objectContaining({
            target_object_id: "memory:grace",
            green_state: "grace"
          })
        ],
        active_overrides: [
          expect.objectContaining({
            override_id: "11111111-1111-4111-8111-111111111111",
            target_object: "memory:style",
            correction: "Prefer pnpm",
            priority: 2
          })
        ],
        governance_lease: {
          held: true,
          lease_id: "22222222-2222-4222-8222-222222222222",
          holder: "run:run-1:turn:turn-1",
          expires_at: "2026-03-25T00:05:00.000Z"
        },
        snapshot_at: "2026-03-25T00:00:04.000Z"
      }
    });
    expect(body.data.green_statuses.map((status) => status.target_object_id)).toEqual([
      "memory:revoked",
      "memory:eligible",
      "memory:grace"
    ]);
    expect(runService.getById).toHaveBeenCalledWith("run-1");
    expect(greenService.findAll).toHaveBeenCalledWith("workspace-1");
    expect(sessionOverrideService.getActiveFor).toHaveBeenCalledWith("run-1");
    expect(governanceLeaseService.getActive).toHaveBeenCalledWith("run-1");
  });

  it("returns 400 when an injected governance clock is invalid", async () => {
    const { app } = createGovernanceApp({
      now: () => "not-a-timestamp"
    });

    const response = await app.request("/runs/run-1/governance-snapshot");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "governance route clock must return a valid ISO timestamp"
    });
  });

  it("breaks green status ties deterministically by target object id", async () => {
    const { app } = createGovernanceApp({
      greenService: {
        findAll: vi.fn(async () => [
          createGreenStatus({
            target_object_id: "memory:zeta",
            last_transition_at: "2026-03-25T00:00:00.000Z"
          }),
          createGreenStatus({
            target_object_id: "memory:alpha",
            last_transition_at: "2026-03-25T00:00:00.000Z"
          })
        ])
      }
    });

    const response = await app.request("/runs/run-1/governance-snapshot");
    const body = (await response.json()) as {
      readonly data: {
        readonly green_statuses: readonly { readonly target_object_id: string }[];
      };
    };

    expect(response.status).toBe(200);
    expect(body.data.green_statuses.map((status) => status.target_object_id)).toEqual([
      "memory:alpha",
      "memory:zeta"
    ]);
  });

  it("returns an empty lease state when no lease is held", async () => {
    const { app } = createGovernanceApp({
      governanceLeaseService: {
        getActive: vi.fn(async () => null)
      }
    });

    const response = await app.request("/runs/run-1/governance-snapshot");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        governance_lease: {
          held: false,
          lease_id: null,
          holder: null,
          expires_at: null
        }
      }
    });
  });

  it("returns 404 for unknown runs", async () => {
    const { app } = createGovernanceApp({
      runService: {
        getById: vi.fn(async () => {
          throw new CoreError("NOT_FOUND", "Run not found");
        })
      }
    });

    const response = await app.request("/runs/run-missing/governance-snapshot");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Resource not found"
    });
  });

  it("does not register the route when governance services are absent", async () => {
    const app = createApp({
      workspaceService: {} as any,
      runService: {
        getById: vi.fn(async (runId: string) => ({ run_id: runId, workspace_id: "workspace-1" }))
      } as any,
      conversationService: createNoopConversationService("governance routes") as any,
      engineBindingService: createStubEngineBindingService() as any,
      runHotStateService: {
        getByRunId: vi.fn(async () => null)
      } as any,
      sseManager: {} as any,
      signalService: createUnusedSignalService("governance routes") as any,
      evidenceService: createUnusedEvidenceService("governance routes") as any,
      memoryService: createUnusedMemoryService("governance routes") as any,
      slotService: createUnusedSlotService("governance routes") as any,
      synthesisService: createUnusedSynthesisService("governance routes") as any,
      claimService: createUnusedClaimService("governance routes") as any,
      proposalService: createUnusedProposalService("governance routes") as any
    });

    const response = await app.request("/runs/run-1/governance-snapshot");

    expect(response.status).toBe(404);
  });
});

function createGovernanceApp(overrides: Partial<{
  readonly runService: { readonly getById: ReturnType<typeof vi.fn> };
      readonly greenService: { readonly findAll: ReturnType<typeof vi.fn> };
      readonly sessionOverrideService: { readonly getActiveFor: ReturnType<typeof vi.fn> };
      readonly governanceLeaseService: { readonly getActive: ReturnType<typeof vi.fn> };
  readonly now: () => string;
}> = {}) {
  const runService =
    overrides.runService ??
    {
      getById: vi.fn(async (runId: string) => ({ run_id: runId, workspace_id: "workspace-1" }))
    };
  const greenService =
    overrides.greenService ??
    {
      findAll: vi.fn(async () => [])
    };
  const sessionOverrideService =
    overrides.sessionOverrideService ??
    {
      getActiveFor: vi.fn(async () => [])
    };
  const governanceLeaseService =
    overrides.governanceLeaseService ??
    {
      getActive: vi.fn(async () => null)
    };

  const app = createApp({
    workspaceService: {} as any,
    runService: runService as any,
    conversationService: createNoopConversationService("governance routes") as any,
    engineBindingService: createStubEngineBindingService() as any,
    runHotStateService: {
      getByRunId: vi.fn(async () => null)
    } as any,
    sseManager: {} as any,
    signalService: createUnusedSignalService("governance routes") as any,
    evidenceService: createUnusedEvidenceService("governance routes") as any,
    memoryService: createUnusedMemoryService("governance routes") as any,
    greenService: greenService as any,
    governanceLeaseService: governanceLeaseService as any,
    governanceNow: overrides.now,
    sessionOverrideService: sessionOverrideService as any,
    slotService: createUnusedSlotService("governance routes") as any,
    synthesisService: createUnusedSynthesisService("governance routes") as any,
    claimService: createUnusedClaimService("governance routes") as any,
    proposalService: createUnusedProposalService("governance routes") as any
  });

  return {
    app,
    runService,
    greenService,
    sessionOverrideService,
    governanceLeaseService
  };
}

function createGreenStatus(overrides: Partial<{
  target_object_id: string;
  green_state: "eligible" | "grace" | "revoked";
  revoke_reason: string;
  last_transition_at: string;
}> = {}) {
  return {
    object_id: "green-status-object-1",
    object_kind: "green_status",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-25T00:00:00.000Z",
    updated_at: "2026-03-25T00:00:00.000Z",
    created_by: "system",
    target_object_id: overrides.target_object_id ?? "memory:eligible",
    target_object_kind: "memory_entry",
    green_state: overrides.green_state ?? "eligible",
    verification_basis: "passive_stable",
    verified_by: "system_passive_check",
    verified_at: "2026-03-25T00:00:00.000Z",
    valid_until: null,
    bound_surfaces: null,
    bound_scope_class: "project",
    revoke_reason: overrides.revoke_reason ?? "none",
    last_transition_at: overrides.last_transition_at ?? "2026-03-25T00:00:00.000Z",
    workspace_id: "workspace-1"
  };
}
