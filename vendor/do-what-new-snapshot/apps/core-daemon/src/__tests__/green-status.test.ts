import { describe, expect, it, vi } from "vitest";
import type { SurfaceAnchorRepo } from "@do-what/storage";
import { createApp } from "../app.js";
import {
  createNoopConversationService,
  createStubEngineBindingService,
  createUnusedClaimService,
  createUnusedCrossCuttingPermissionService,
  createUnusedEvidenceService,
  createUnusedMemoryService,
  createUnusedProposalService,
  createUnusedSignalService,
  createUnusedSlotService,
  createUnusedSurfaceBindingService,
  createUnusedSurfaceService,
  createUnusedSynthesisService
} from "./helpers/mock-services.js";

function createGreenStatus(overrides: Record<string, unknown> = {}) {
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

function createVerificationResult(verdict: "go" | "no_go") {
  return {
    runtime_id: "00000000-0000-4000-8000-000000000000",
    object_kind: "verification_result",
    task_surface_ref: null,
    expires_at: null,
    derived_from: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
    retention_policy: "session_only",
    verdict,
    micro_correction_hint: verdict === "go" ? null : "needs attention",
    necessary_patch: null
  };
}

function createRouteApp() {
  const greenStatus = createGreenStatus();
  const greenService = {
    findEligible: vi.fn(async () => [greenStatus]),
    findGrace: vi.fn(async () => [createGreenStatus({ object_id: "f8d69cae-df52-4df9-9147-d0fd1f998b8b", green_state: "grace" })]),
    getStatus: vi.fn(async (targetObjectId: string) =>
      targetObjectId === greenStatus.target_object_id ? greenStatus : null
    ),
    runVerification: vi.fn(async ({ verdict }: { verdict: "go" | "no_go" }) => createVerificationResult(verdict))
  };

  const workspaceService = {
    getById: vi.fn(async (workspaceId: string) => ({ workspace_id: workspaceId }))
  };

  const app = createApp({
    workspaceService: workspaceService as any,
    runService: {
      getById: vi.fn(async (runId: string) => ({ run_id: runId }))
    } as any,
    conversationService: createNoopConversationService("green status routes") as any,
    engineBindingService: createStubEngineBindingService() as any,
    runHotStateService: {
      getByRunId: vi.fn(async () => null)
    } as any,
    sseManager: {} as any,
    signalService: createUnusedSignalService("green status routes") as any,
    evidenceService: createUnusedEvidenceService("green status routes") as any,
    memoryService: createUnusedMemoryService("green status routes") as any,
    greenService: greenService as any,
    slotService: createUnusedSlotService("green status routes") as any,
    surfaceService: createUnusedSurfaceService("green status routes") as any,
    surfaceAnchorRepo: { findByWorkspace: vi.fn(async () => []) } as unknown as SurfaceAnchorRepo,
    surfaceBindingService: createUnusedSurfaceBindingService("green status routes") as any,
    crossCuttingPermissionService: createUnusedCrossCuttingPermissionService("green status routes") as any,
    synthesisService: createUnusedSynthesisService("green status routes") as any,
    claimService: createUnusedClaimService("green status routes") as any,
    proposalService: createUnusedProposalService("green status routes") as any
  });

  return { app, greenService };
}

describe("green status routes", () => {
  it("lists eligible and grace green statuses", async () => {
    const { app } = createRouteApp();

    const response = await app.request("/workspaces/workspace-1/green-statuses");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        total_count: 2,
        eligible: [expect.objectContaining({ green_state: "eligible" })],
        grace: [expect.objectContaining({ green_state: "grace" })]
      }
    });
  });

  it("returns a single green status by target object id", async () => {
    const { app } = createRouteApp();

    const response = await app.request(
      "/workspaces/workspace-1/green-statuses/70a0b18b-5f8b-4fd2-a1b0-97ce48113fca"
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        target_object_id: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca"
      }
    });
  });

  it("returns 404 for unknown green statuses", async () => {
    const { app } = createRouteApp();

    const response = await app.request("/workspaces/workspace-1/green-statuses/missing-memory");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Resource not found"
    });
  });

  it("runs verification with go verdict", async () => {
    const { app } = createRouteApp();

    const response = await app.request("/workspaces/workspace-1/green-statuses/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        target_object_id: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
        verdict: "go"
      })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        verdict: "go"
      }
    });
  });

  it("runs verification with no_go verdict", async () => {
    const { app } = createRouteApp();

    const response = await app.request("/workspaces/workspace-1/green-statuses/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        target_object_id: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
        verdict: "no_go",
        micro_correction_hint: "needs attention"
      })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        verdict: "no_go"
      }
    });
  });

  it("returns 400 when target_object_id is empty", async () => {
    const { app } = createRouteApp();

    const response = await app.request("/workspaces/workspace-1/green-statuses/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        target_object_id: "",
        verdict: "go"
      })
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Invalid verification payload"
    });
  });

  it("returns 400 when micro_correction_hint has an invalid type", async () => {
    const { app } = createRouteApp();

    const response = await app.request("/workspaces/workspace-1/green-statuses/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        target_object_id: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
        verdict: "no_go",
        micro_correction_hint: 123
      })
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Invalid verification payload"
    });
  });
});
