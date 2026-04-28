import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { HealthEventKind } from "@do-what/protocol";
import { createApp } from "../app.js";
import { registerErrorHandler } from "../middleware/error-handler.js";
import { registerHealthJournalRoutes } from "../routes/health-journal.js";
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

describe("health journal routes", () => {
  it("lists health journal entries for a workspace with optional query params", async () => {
    const workspaceService = {
      getById: vi.fn(async (workspaceId: string) => ({ workspace_id: workspaceId }))
    };
    const healthJournalService = {
      getRecentEvents: vi.fn(async () => [
        {
          entry_id: "11111111-1111-4111-8111-111111111111",
          event_kind: HealthEventKind.EVIDENCE_FAILURE,
          workspace_id: "workspace-1",
          run_id: null,
          summary: "Broken evidence ref.",
          detail_json: { target_object_id: "memory-1" },
          created_at: "2026-03-27T00:00:00.000Z"
        }
      ])
    };
    const app = new Hono();
    registerErrorHandler(app);
    registerHealthJournalRoutes(app, {
      workspaceService: workspaceService as any,
      healthJournalService: healthJournalService as any
    });

    const response = await app.request("/workspaces/workspace-1/health-journal?kind=evidence_failure&limit=5");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        entries: [
          expect.objectContaining({
            event_kind: HealthEventKind.EVIDENCE_FAILURE
          })
        ]
      }
    });
    expect(workspaceService.getById).toHaveBeenCalledWith("workspace-1");
    expect(healthJournalService.getRecentEvents).toHaveBeenCalledWith("workspace-1", {
      kind: HealthEventKind.EVIDENCE_FAILURE,
      limit: 5
    });
  });

  it("returns 400 for invalid query params", async () => {
    const app = new Hono();
    registerErrorHandler(app);
    registerHealthJournalRoutes(app, {
      workspaceService: {
        getById: vi.fn(async () => ({ workspace_id: "workspace-1" }))
      } as any,
      healthJournalService: {
        getRecentEvents: vi.fn(async () => [])
      } as any
    });

    const response = await app.request("/workspaces/workspace-1/health-journal?limit=0");

    expect(response.status).toBe(400);
  });

  it("caps route-level limits before delegating to the service", async () => {
    const workspaceService = {
      getById: vi.fn(async (workspaceId: string) => ({ workspace_id: workspaceId }))
    };
    const healthJournalService = {
      getRecentEvents: vi.fn(async () => [])
    };
    const app = new Hono();
    registerErrorHandler(app);
    registerHealthJournalRoutes(app, {
      workspaceService: workspaceService as any,
      healthJournalService: healthJournalService as any
    });

    const response = await app.request("/workspaces/workspace-1/health-journal?limit=999");

    expect(response.status).toBe(200);
    expect(healthJournalService.getRecentEvents).toHaveBeenCalledWith("workspace-1", {
      kind: undefined,
      limit: 200
    });
  });

  it("does not register the route when the service is absent", async () => {
    const app = createApp({
      workspaceService: {} as any,
      runService: {
        getById: vi.fn(async (runId: string) => ({ run_id: runId, workspace_id: "workspace-1" }))
      } as any,
      conversationService: createNoopConversationService("health journal routes") as any,
      engineBindingService: createStubEngineBindingService() as any,
      runHotStateService: {
        getByRunId: vi.fn(async () => null)
      } as any,
      sseManager: {} as any,
      signalService: createUnusedSignalService("health journal routes") as any,
      evidenceService: createUnusedEvidenceService("health journal routes") as any,
      memoryService: createUnusedMemoryService("health journal routes") as any,
      slotService: createUnusedSlotService("health journal routes") as any,
      synthesisService: createUnusedSynthesisService("health journal routes") as any,
      claimService: createUnusedClaimService("health journal routes") as any,
      proposalService: createUnusedProposalService("health journal routes") as any
    });

    const response = await app.request("/workspaces/workspace-1/health-journal");

    expect(response.status).toBe(404);
  });
});
