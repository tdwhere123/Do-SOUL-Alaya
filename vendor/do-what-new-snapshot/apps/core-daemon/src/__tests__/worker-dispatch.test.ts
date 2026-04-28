import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReadableStreamDefaultReader, ReadableStreamReadResult } from "node:stream/web";
import type {
  AgentRuntimePort,
  ConstitutionalFragment,
  DelegatedWorkerRun,
  RuntimeCancelResult,
  RuntimeCapabilities,
  RuntimeSession,
  RuntimeSessionConfig,
  WorkerBaselineLock
} from "@do-what/protocol";
import { ConstitutionalFragmentSchema, PromptAssetSchema, WorkspaceKind } from "@do-what/protocol";
import { NarrativeBudgetConfigSchema } from "@do-what/protocol";
import {
  PromptAssetRegistry,
  WORKER_IDENTITY_FRAGMENT,
  EventPublisher,
  IntegrationGate,
  RunHotStateService,
  RunService,
  SerialDelegationService,
  VERIFIED_CLAUDE_RUNTIME_CAPABILITY_PROFILE,
  WorkerDispatchPromptAssembler,
  WorkerRunLifecycleService,
  WorkspaceService
} from "@do-what/core";
import {
  SqliteEngineBindingRepo,
  SqliteEventLogRepo,
  SqliteRunRepo,
  SqliteWorkerRunRepo,
  SqliteWorkspaceRepo,
  initDatabase,
  type StorageDatabase
} from "@do-what/storage";
import { createApp } from "../app.js";
import {
  configureWorkspacePrincipalCodingEngine,
  createNoopConversationService,
  createStubEngineBindingService,
  createUnusedClaimService,
  createUnusedEvidenceService,
  createUnusedMemoryService,
  createUnusedProposalService,
  createUnusedSignalService,
  createUnusedSlotService,
  createUnusedSynthesisService,
  createUnusedSurfaceService
} from "./helpers/mock-services.js";
import { SseManager } from "../sse/sse-manager.js";

const FIXED_NOW = "2026-04-14T06:30:00.000Z";
const workerDispatchHardConstraintContent =
  "Never mutate files outside approved workspace roots.";
const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

describe("worker dispatch routes", () => {
  it("dispatches a worker and normalizes principal/workspace ids from the route run", async () => {
    const dispatchSpy = vi.fn(async (input) =>
      createWorkerRun({
        worker_run_id: "worker-route-1",
        principal_run_id: input.principalRunId,
        workspace_id: input.workspaceId,
        state: "active"
      })
    );
    const context = createTestContext({
      serialDelegationService: {
        dispatch: dispatchSpy
      }
    });
    const workspace = await createWorkspace(context.app, "worker-route");
    const runId = await createRun(context.app, workspace.workspace_id, "worker dispatch");

    const response = await context.app.request(`/runs/${runId}/workers/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createDispatchPayload({
        sessionConfig: {
          ...createSessionConfig(),
          workspace_id: "wrong-workspace",
          run_id: "wrong-run"
        }
      }))
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        worker_run_id: "worker-route-1",
        principal_run_id: runId,
        workspace_id: workspace.workspace_id,
        state: "active"
      }
    });
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        principalRunId: runId,
        workspaceId: workspace.workspace_id,
        sessionConfig: expect.objectContaining({
          workspace_id: workspace.workspace_id,
          run_id: runId
        })
      })
    );
  });

  it("assembles backend-owned worker prompts with PromptAssetRegistry before serial delegation dispatch", async () => {
    const dispatchSpy = vi.fn(async (input) =>
      createWorkerRun({
        worker_run_id: "worker-route-assembled-1",
        principal_run_id: input.principalRunId,
        workspace_id: input.workspaceId,
        state: "active"
      })
    );
    const promptAssetRegistry = new PromptAssetRegistry();
    promptAssetRegistry.register(WORKER_IDENTITY_FRAGMENT);
    promptAssetRegistry.register(
      PromptAssetSchema.parse({
        asset_id: "constraint://worker-dispatch",
        kind: "constitutional",
        label: "Worker Dispatch Constraint",
        content: "Never mutate files outside approved roots.",
        priority: 95,
        immutable: true
      })
    );
    const promptAssembler = new WorkerDispatchPromptAssembler({
      promptAssetRegistry,
      warn: () => undefined
    });
    const context = createTestContext({
      serialDelegationService: {
        dispatch: dispatchSpy
      },
      workerDispatchPromptAssembler: promptAssembler
    });
    const workspace = await createWorkspace(context.app, "worker-route-assembled");
    const runId = await createRun(context.app, workspace.workspace_id, "worker dispatch assembled");

    const response = await context.app.request(`/runs/${runId}/workers/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        createDispatchPayload({
          principalSecuritySnapshot: {
            governance_lease_ref: "lease://client-manufactured",
            hard_constraint_refs: ["constraint://worker-dispatch"],
            denied_tool_categories: ["network"]
          }
        })
      )
    });

    expect(response.status).toBe(201);
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("## Worker Identity")
      })
    );
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("## Worker Baseline Safety Constraints")
      })
    );
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("## Worker Task")
      })
    );
  });

  it("hydrates worker-dispatch constitutional fragments from the live fragment loader instead of bootstrap-copied registry assets", async () => {
    const dispatchSpy = vi.fn(async (input) =>
      createWorkerRun({
        worker_run_id: "worker-route-fragment-loader-1",
        principal_run_id: input.principalRunId,
        workspace_id: input.workspaceId,
        state: "active"
      })
    );
    const promptAssetRegistry = new PromptAssetRegistry();
    promptAssetRegistry.register(WORKER_IDENTITY_FRAGMENT);
    const promptAssembler = new WorkerDispatchPromptAssembler({
      constitutionalFragmentReader: {
        listForWorkspace: async (workspaceId) =>
          Object.freeze([
            ConstitutionalFragmentSchema.parse({
              fragment_id: resolveStaticWorkerDispatchFragmentId(
                workspaceId,
                "Never mutate files outside approved roots."
              ),
              workspace_id: workspaceId,
              category: "hard_constraint",
              content: "Never mutate files outside approved roots.",
              authority_source: "system.worker_dispatch",
              immutable: true,
              registered_at: FIXED_NOW
            })
          ]) as readonly Readonly<ConstitutionalFragment>[]
      },
      promptAssetRegistry,
      warn: () => undefined
    });
    const context = createTestContext({
      serialDelegationService: {
        dispatch: dispatchSpy
      },
      workerDispatchPromptAssembler: promptAssembler
    });
    const workspace = await createWorkspace(context.app, "worker-route-fragment-loader");
    const runId = await createRun(context.app, workspace.workspace_id, "worker dispatch fragment loader");

    const response = await context.app.request(`/runs/${runId}/workers/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        createDispatchPayload({
          principalSecuritySnapshot: {
            governance_lease_ref: "lease://client-manufactured",
            hard_constraint_refs: ["constraint://worker-dispatch"],
            denied_tool_categories: ["network"]
          }
        })
      )
    });

    expect(response.status).toBe(201);
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("Never mutate files outside approved roots.")
      })
    );
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('Active hard constraints: "constraint://worker-dispatch')
      })
    );
  });

  it("keeps caller hard_constraint_refs scope and validates refs against server truth", async () => {
    const dispatchSpy = vi.fn(async (input) =>
      createWorkerRun({
        worker_run_id: "worker-route-server-truth-1",
        principal_run_id: input.principalRunId,
        workspace_id: input.workspaceId,
        state: "active"
      })
    );
    const promptAssetRegistry = new PromptAssetRegistry();
    promptAssetRegistry.register(WORKER_IDENTITY_FRAGMENT);
    promptAssetRegistry.register(
      PromptAssetSchema.parse({
        asset_id: "operational:unsafe-hard-ref",
        kind: "operational",
        label: "Unsafe Hard Ref",
        content: "rm -rf /",
        priority: 10,
        immutable: false
      })
    );
    const promptAssembler = new WorkerDispatchPromptAssembler({
      promptAssetRegistry,
      warn: () => undefined
    });
    const context = createTestContext({
      serialDelegationService: {
        dispatch: dispatchSpy
      },
      workerDispatchPromptAssembler: promptAssembler,
      listServerHardConstraints: async () => [
        {
          ref: "claim-safe-1",
          content: "Never mutate files outside approved workspace roots."
        }
      ]
    });
    const workspace = await createWorkspace(context.app, "worker-route-server-truth");
    const runId = await createRun(context.app, workspace.workspace_id, "worker dispatch server truth");

    const response = await context.app.request(`/runs/${runId}/workers/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        createDispatchPayload({
          principalSecuritySnapshot: {
            governance_lease_ref: "lease://principal/worker-dispatch",
            hard_constraint_refs: ["operational:unsafe-hard-ref"],
            denied_tool_categories: ["network"]
          }
        })
      )
    });

    expect(response.status).toBe(201);
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        principalSecuritySnapshot: expect.objectContaining({
          hard_constraint_refs: []
        }),
        prompt: expect.not.stringContaining("claim-safe-1")
      })
    );
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.not.stringContaining(
          'Active hard constraints: "operational:unsafe-hard-ref'
        )
      })
    );
  });

  it("stores resolved immutable worker-dispatch refs in the final worker security snapshot when server truth allows the alias", async () => {
    const dispatchSpy = vi.fn(async (input) =>
      createWorkerRun({
        worker_run_id: "worker-route-static-alias-1",
        principal_run_id: input.principalRunId,
        workspace_id: input.workspaceId,
        state: "active"
      })
    );
    const promptAssembler = new WorkerDispatchPromptAssembler({
      promptAssetRegistry: new PromptAssetRegistry(),
      warn: () => undefined
    });
    const context = createTestContext({
      serialDelegationService: {
        dispatch: dispatchSpy
      },
      workerDispatchPromptAssembler: promptAssembler,
      listServerHardConstraints: async (workspaceId) => [
        {
          ref: "constraint://worker-dispatch",
          resolved_ref: resolveStaticWorkerDispatchFragmentId(
            workspaceId,
            workerDispatchHardConstraintContent
          ),
          content: workerDispatchHardConstraintContent
        }
      ]
    });
    const workspace = await createWorkspace(context.app, "worker-route-static-alias");
    const runId = await createRun(context.app, workspace.workspace_id, "worker dispatch static alias");
    const resolvedConstraintRef = resolveStaticWorkerDispatchFragmentId(
      workspace.workspace_id,
      workerDispatchHardConstraintContent
    );

    const response = await context.app.request(`/runs/${runId}/workers/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        createDispatchPayload({
          principalSecuritySnapshot: {
            governance_lease_ref: "lease://principal/worker-dispatch",
            hard_constraint_refs: ["constraint://worker-dispatch"],
            denied_tool_categories: ["network"]
          }
        })
      )
    });

    expect(response.status).toBe(201);
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        principalSecuritySnapshot: expect.objectContaining({
          hard_constraint_refs: [resolvedConstraintRef]
        }),
        prompt: expect.stringContaining(
          `Active hard constraints: "${resolvedConstraintRef}: ${workerDispatchHardConstraintContent}"`
        )
      })
    );
  });

  it("runs narrative budget and worker trust assessment on the dispatch live path without blocking the response", async () => {
    const dispatchSpy = vi.fn(async (input) =>
      createWorkerRun({
        worker_run_id: "worker-route-assessment-1",
        principal_run_id: input.principalRunId,
        workspace_id: input.workspaceId,
        state: "active",
        restricted_tool_set: ["read_file"]
      })
    );
    let releaseBudgetCheck: (() => void) | null = null;
    const workerTrustAssessor = {
      assess: vi.fn(async () => undefined)
    };
    const narrativeBudgetService = {
      checkBudget: vi.fn(
        async () =>
          await new Promise<{
            readonly withinLimits: boolean;
            readonly currentBytes: number;
            readonly currentCount: number;
          }>((resolve) => {
            releaseBudgetCheck = () => {
              resolve({
                withinLimits: false,
                currentBytes: 8192,
                currentCount: 8
              });
            };
          })
      ),
      triggerConsolidation: vi.fn(async () => undefined)
    };
    const context = createTestContext({
      serialDelegationService: {
        dispatch: dispatchSpy
      },
      workerTrustAssessor,
      narrativeBudgetService,
      narrativeBudgetConfig: {
        max_total_digest_bytes: 1024,
        max_digests_per_run: 2,
        consolidation_threshold_pct: 100
      }
    });
    const workspace = await createWorkspace(context.app, "worker-route-assessment");
    const runId = await createRun(context.app, workspace.workspace_id, "worker dispatch assessment");

    const responseResult = await Promise.race([
      context.app.request(`/runs/${runId}/workers/dispatch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(createDispatchPayload())
      }),
      new Promise<null>((resolve) => {
        setTimeout(() => {
          resolve(null);
        }, 500);
      })
    ]);

    expect(responseResult).not.toBeNull();
    if (responseResult === null) {
      throw new Error("worker dispatch response timed out while post-dispatch governance was pending");
    }
    const response = responseResult;
    expect(response.status).toBe(201);

    await waitForExpectation(() => expect(releaseBudgetCheck).not.toBeNull());
    releaseBudgetCheck?.();

    await waitForExpectation(() =>
      expect(narrativeBudgetService.checkBudget).toHaveBeenCalledWith(
        workspace.workspace_id,
        runId,
        expect.objectContaining({
          max_total_digest_bytes: 1024,
          max_digests_per_run: 2
        })
      )
    );
    await waitForExpectation(() =>
      expect(narrativeBudgetService.triggerConsolidation).toHaveBeenCalledWith(
        workspace.workspace_id,
        runId
      )
    );
    await waitForExpectation(() =>
      expect(workerTrustAssessor.assess).toHaveBeenCalledWith(
        expect.objectContaining({
          hardConstraintCount: expect.any(Number),
          toolSetRestricted: true,
          budgetStatus: expect.objectContaining({
            withinLimits: false
          })
        })
      )
    );
  });

  it("derives trust hasGovernanceLease from final backend-owned worker security snapshot", async () => {
    const dispatchSpy = vi.fn(async (input) =>
      createWorkerRun({
        worker_run_id: "worker-route-live-lease-1",
        principal_run_id: input.principalRunId,
        workspace_id: input.workspaceId,
        state: "active",
        principal_security_snapshot: {
          governance_lease_ref: "governance://no-live-lease/synthesized",
          hard_constraint_refs: ["constraint://worker-dispatch", "constraint://server-added"],
          denied_tool_categories: ["network"]
        }
      })
    );
    const workerTrustAssessor = {
      assess: vi.fn(async () => undefined)
    };
    const governanceLeaseService = {
      getActive: vi.fn(async () => null)
    };
    const context = createTestContext({
      serialDelegationService: {
        dispatch: dispatchSpy
      },
      workerTrustAssessor,
      governanceLeaseService
    });
    const workspace = await createWorkspace(context.app, "worker-route-live-lease");
    const runId = await createRun(context.app, workspace.workspace_id, "worker dispatch live lease");

    const response = await context.app.request(`/runs/${runId}/workers/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createDispatchPayload())
    });

    expect(response.status).toBe(201);
    expect(governanceLeaseService.getActive).toHaveBeenCalledWith(runId);
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        principalSecuritySnapshot: expect.objectContaining({
          governance_lease_ref: expect.stringMatching(/^governance:\/\/no-live-lease\//)
        })
      })
    );
    await waitForExpectation(() =>
      expect(workerTrustAssessor.assess).toHaveBeenCalledWith(
        expect.objectContaining({
          hasGovernanceLease: false,
          hardConstraintCount: 2
        })
      )
    );
  });

  it("skips trust assessment when narrative budget truth is unavailable after checkBudget throws", async () => {
    const dispatchSpy = vi.fn(async (input) =>
      createWorkerRun({
        worker_run_id: "worker-route-budget-fail-closed-1",
        principal_run_id: input.principalRunId,
        workspace_id: input.workspaceId,
        state: "active"
      })
    );
    const warn = vi.fn();
    const workerTrustAssessor = {
      assess: vi.fn(async () => undefined)
    };
    const narrativeBudgetService = {
      checkBudget: vi.fn(async () => {
        throw new Error("budget check exploded");
      }),
      triggerConsolidation: vi.fn(async () => undefined)
    };
    const context = createTestContext({
      serialDelegationService: {
        dispatch: dispatchSpy
      },
      workerTrustAssessor,
      narrativeBudgetService,
      warn
    });
    const workspace = await createWorkspace(context.app, "worker-route-budget-fail-closed");
    const runId = await createRun(context.app, workspace.workspace_id, "worker dispatch budget fail-closed");

    const response = await context.app.request(`/runs/${runId}/workers/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createDispatchPayload())
    });

    expect(response.status).toBe(201);

    await waitForExpectation(() =>
      expect(narrativeBudgetService.checkBudget).toHaveBeenCalledWith(
        workspace.workspace_id,
        runId,
        expect.any(Object)
      )
    );
    await waitForExpectation(() =>
      expect(warn).toHaveBeenCalledWith(
        "narrative budget post-dispatch check failed",
        expect.objectContaining({
          workspaceId: workspace.workspace_id,
          runId
        })
      )
    );
    expect(workerTrustAssessor.assess).not.toHaveBeenCalled();
    expect(narrativeBudgetService.triggerConsolidation).not.toHaveBeenCalled();
  });

  it("returns 409 on hard_stale, freezes the worker, and broadcasts worker.integration_status over SSE", async () => {
    const context = createTestContext();
    const workspace = await createWorkspace(context.app, "worker-hard-stale");
    const runId = await createRun(context.app, workspace.workspace_id, "hard stale");
    const sseResponse = await context.app.request(`/runs/${runId}/events`);
    const sse = createSseClient(sseResponse);
    await sse.readEvent();

    const response = await context.app.request(`/runs/${runId}/workers/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        createDispatchPayload({
          sessionConfig: {
            ...createSessionConfig(),
            workspace_id: workspace.workspace_id,
            run_id: runId
          }
        })
      )
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: {
        code: "integration_hard_stale",
        status: "conflict",
        detail: "Worker integration drift is hard-stale; dispatch is blocked until the runtime baseline is repaired."
      }
    });
    const integrationEvent = await sse.readEvent();
    expect(integrationEvent.event).toBe("worker.integration_status");
    expect(integrationEvent.data).toMatchObject({
      workerRunId: "worker-run-hard-stale",
      level: "hard_stale",
      reason: "supports_streaming_updates expected=true actual=false",
      detectedAt: FIXED_NOW
    });
    const frozenEvent = await sse.readEvent();
    expect(frozenEvent.event).toBe("worker.state_changed");
    expect(frozenEvent.data).toMatchObject({
      workerId: "worker-run-hard-stale",
      state: "frozen",
      previousState: "init"
    });

    const persistedWorker = await context.workerRunRepo.getById("worker-run-hard-stale");
    expect(persistedWorker?.state).toBe("frozen");
    const workerEvents = (await context.eventLogRepo.queryByRun(runId)).filter(
      (event) => event.entity_type === "worker_run"
    );
    expect(workerEvents.map((event) => event.event_type)).toEqual([
      "worker.integration_status",
      "worker.state_changed"
    ]);
    expect(context.runtimeAdapterSpies?.createSession).not.toHaveBeenCalled();

    await sse.close();
    await waitForCondition(() => context.sseManager.connectionCount(runId) === 0);
  });

  it("does not emit worker.integration_status when runtime capabilities match the declared baseline", async () => {
    const context = createTestContext({
      integrationMode: "ignore_drift"
    });
    const workspace = await createWorkspace(context.app, "worker-ignore-drift");
    const runId = await createRun(context.app, workspace.workspace_id, "ignore drift");

    const response = await context.app.request(`/runs/${runId}/workers/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        createDispatchPayload({
          sessionConfig: {
            ...createSessionConfig(),
            workspace_id: workspace.workspace_id,
            run_id: runId
          }
        })
      )
    });

    expect(response.status).toBe(201);
    const workerEvents = (await context.eventLogRepo.queryByRun(runId)).filter(
      (event) => event.entity_type === "worker_run"
    );
    expect(workerEvents.map((event) => event.event_type)).toEqual(["worker.state_changed"]);
    expect(context.runtimeAdapterSpies?.createSession).toHaveBeenCalledTimes(1);
  });

  it("replays missed worker.integration_status after reconnecting with Last-Event-ID", async () => {
    const context = createTestContext();
    const workspace = await createWorkspace(context.app, "worker-hard-stale-replay");
    const runId = await createRun(context.app, workspace.workspace_id, "hard stale replay");
    const firstSseResponse = await context.app.request(`/runs/${runId}/events`);
    const firstSse = createSseClient(firstSseResponse);
    const connected = await firstSse.readEvent();

    await firstSse.close();
    await waitForCondition(() => context.sseManager.connectionCount(runId) === 0);

    const response = await context.app.request(`/runs/${runId}/workers/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        createDispatchPayload({
          sessionConfig: {
            ...createSessionConfig(),
            workspace_id: workspace.workspace_id,
            run_id: runId
          }
        })
      )
    });

    expect(response.status).toBe(409);

    const sseResponse = await context.app.request(`/runs/${runId}/events`, {
      headers: { "Last-Event-ID": connected.id }
    });
    const sse = createSseClient(sseResponse);
    const replayedEvents = await readEventsByType(sse, [
      "worker.integration_status",
      "worker.state_changed"
    ]);

    expect(replayedEvents).toMatchObject([
      {
        event: "worker.integration_status",
        data: {
          workerRunId: "worker-run-hard-stale",
          level: "hard_stale",
          reason: "supports_streaming_updates expected=true actual=false",
          detectedAt: FIXED_NOW
        }
      },
      {
        event: "worker.state_changed",
        data: {
          workerId: "worker-run-hard-stale",
          state: "frozen",
          previousState: "init"
        }
      }
    ]);

    await sse.close();
    await waitForCondition(() => context.sseManager.connectionCount(runId) === 0);
  });

  it("rejects protected worker dispatch requests when the request token is missing", async () => {
    const dispatchSpy = vi.fn(async (_input) =>
      createWorkerRun({
        worker_run_id: "worker-route-protected",
        principal_run_id: "run-placeholder",
        workspace_id: "workspace-placeholder",
        state: "active"
      })
    );
    const context = createTestContext({
      serialDelegationService: {
        dispatch: dispatchSpy
      },
      requestProtection: {
        allowedOrigin: "http://localhost:5173",
        requestToken: "secret-token"
      }
    });
    const protectedHeaders = {
      origin: "http://localhost:5173",
      "x-request-token": "secret-token"
    };
    const workspace = await createWorkspace(context.app, "worker-protected", protectedHeaders);
    const runId = await createRun(
      context.app,
      workspace.workspace_id,
      "protected worker dispatch",
      protectedHeaders
    );

    const response = await context.app.request(`/runs/${runId}/workers/dispatch`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:5173"
      },
      body: JSON.stringify(createDispatchPayload())
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "X-Request-Token is required"
    });
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it("returns 400 when allowed_return_kinds contains an unsupported enum value", async () => {
    const context = createTestContext();
    const workspace = await createWorkspace(context.app, "worker-invalid-return-kind");
    const runId = await createRun(context.app, workspace.workspace_id, "invalid return kind");

    const response = await context.app.request(`/runs/${runId}/workers/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        createDispatchPayload({
          agreedReturnFormat: {
            allowed_return_kinds: ["analysis_note", "not_a_kind"],
            requires_structured_summary: true
          }
        })
      )
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Invalid request"
    });
  });

  it("returns 400 when denied_tool_categories contains an unsupported enum value", async () => {
    const context = createTestContext();
    const workspace = await createWorkspace(context.app, "worker-invalid-tool-category");
    const runId = await createRun(context.app, workspace.workspace_id, "invalid tool category");

    const response = await context.app.request(`/runs/${runId}/workers/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        createDispatchPayload({
          principalSecuritySnapshot: {
            governance_lease_ref: "lease://principal/worker-dispatch",
            hard_constraint_refs: ["constraint://worker-dispatch"],
            denied_tool_categories: ["network", "not_a_category"]
          }
        })
      )
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Invalid request"
    });
  });

});

function createTestContext(options: {
  readonly serialDelegationService?: Pick<SerialDelegationService, "dispatch">;
  readonly integrationMode?: "hard_stale" | "ignore_drift";
  readonly workerDispatchPromptAssembler?: {
    assemble(input: {
      callerPrompt: string;
      workspaceId: string;
      runId: string;
      principalSecuritySnapshot: {
        governance_lease_ref: string;
        hard_constraint_refs: readonly string[];
        denied_tool_categories: readonly string[];
      };
    }): string | Promise<string>;
  };
  readonly requestProtection?: {
    readonly allowedOrigin: string;
    readonly requestToken: string;
  };
  readonly workerTrustAssessor?: {
    readonly assess: ReturnType<typeof vi.fn>;
  };
  readonly narrativeBudgetService?: {
    readonly checkBudget: ReturnType<typeof vi.fn>;
    readonly triggerConsolidation: ReturnType<typeof vi.fn>;
  };
  readonly narrativeBudgetConfig?: {
    readonly max_total_digest_bytes: number;
    readonly max_digests_per_run: number;
    readonly consolidation_threshold_pct: number;
  };
  readonly listServerHardConstraints?: (
    workspaceId: string
  ) => Promise<
    readonly {
      readonly ref: string;
      readonly resolved_ref?: string;
      readonly content: string;
    }[]
  >;
  readonly governanceLeaseService?: {
    readonly getActive: ReturnType<typeof vi.fn>;
  };
  readonly warn?: (message: string, meta: Record<string, unknown>) => void;
} = {}): {
  readonly app: ReturnType<typeof createApp>;
  readonly eventLogRepo: SqliteEventLogRepo;
  readonly sseManager: SseManager;
  readonly workerRunRepo: SqliteWorkerRunRepo;
  readonly runtimeAdapterSpies?: {
    readonly createSession: ReturnType<typeof vi.fn>;
    readonly prompt: ReturnType<typeof vi.fn>;
  };
} {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);

  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);
  const bindingRepo = new SqliteEngineBindingRepo(database);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const workerRunRepo = new SqliteWorkerRunRepo(database);
  const runHotStateService = new RunHotStateService({ runRepo, eventLogRepo });
  const sseManager = new SseManager(eventLogRepo);
  const eventPublisher = new EventPublisher({
    eventLogRepo,
    runHotStateService,
    sseBroadcaster: sseManager
  });
  const workspaceService = new WorkspaceService({
    workspaceRepo,
    runRepo,
    eventPublisher
  });
  const runService = new RunService({
    workspaceRepo,
    runRepo,
    eventPublisher,
    isPrincipalCodingEngineAvailable: () => true
  });
  const hardStaleService =
    options.serialDelegationService ??
    (options.integrationMode === "ignore_drift"
      ? createIgnoreDriftSerialDelegationService({
          eventPublisher,
          workerRunRepo
        })
      : createHardStaleSerialDelegationService({
          eventPublisher,
          workerRunRepo
        }));

  return {
    app: createApp({
      workspaceService,
      runService,
      principalCodingEngineAvailable: true,
      conversationService: createNoopConversationService("worker dispatch tests") as any,
      engineBindingService: createStubEngineBindingService() as any,
      runHotStateService,
      serialDelegationService: hardStaleService,
      workerDispatchPromptAssembler: options.workerDispatchPromptAssembler,
      workerTrustAssessor: options.workerTrustAssessor,
      narrativeBudgetService: options.narrativeBudgetService,
      narrativeBudgetConfig:
        options.narrativeBudgetConfig === undefined
          ? undefined
          : NarrativeBudgetConfigSchema.parse(options.narrativeBudgetConfig),
      listServerHardConstraints: options.listServerHardConstraints,
      governanceLeaseService: options.governanceLeaseService as any,
      warn: options.warn,
      sseManager,
      signalService: createUnusedSignalService("worker dispatch tests") as any,
      evidenceService: createUnusedEvidenceService("worker dispatch tests") as any,
      memoryService: createUnusedMemoryService("worker dispatch tests") as any,
      slotService: createUnusedSlotService("worker dispatch tests") as any,
      surfaceService: createUnusedSurfaceService("worker dispatch tests") as any,
      synthesisService: createUnusedSynthesisService("worker dispatch tests") as any,
      claimService: createUnusedClaimService("worker dispatch tests") as any,
      proposalService: createUnusedProposalService("worker dispatch tests") as any,
      requestProtection: options.requestProtection
    }),
    eventLogRepo,
    sseManager,
    workerRunRepo,
    runtimeAdapterSpies:
      "runtimeAdapterSpies" in hardStaleService ? (hardStaleService as any).runtimeAdapterSpies : undefined
  };
}

function createHardStaleSerialDelegationService(options: {
  readonly eventPublisher?: EventPublisher;
  readonly workerRunRepo?: SqliteWorkerRunRepo;
}): Pick<SerialDelegationService, "dispatch"> & {
  readonly runtimeAdapterSpies: {
    readonly createSession: ReturnType<typeof vi.fn>;
    readonly prompt: ReturnType<typeof vi.fn>;
  };
} {
  if (options.eventPublisher === undefined || options.workerRunRepo === undefined) {
    return {
      dispatch: vi.fn(async () => {
        throw new Error("createHardStaleSerialDelegationService requires eventPublisher and workerRunRepo");
      }),
      runtimeAdapterSpies: {
        createSession: vi.fn(),
        prompt: vi.fn()
      }
    };
  }

  const runtimeAdapter = createRuntimeAdapter({
    supports_streaming_updates: false
  });
  const workerRunLifecycle = new WorkerRunLifecycleService({
    repo: options.workerRunRepo,
    eventPublisher: options.eventPublisher,
    now: () => FIXED_NOW
  });
  const dirtyStatePanicService = {
    triggerPanic: vi.fn(
      async (params: {
        workerRunId: string;
        trigger: string;
        panicSource: string;
        summary: string;
        affectedScope: readonly { entity_type: string; entity_id: string }[];
      }) =>
        await workerRunLifecycle.freeze(params.workerRunId, params.panicSource, params.summary)
    )
  };
  const serialDelegationService = new SerialDelegationService({
    workerRunLifecycle,
    workerRunRepo: options.workerRunRepo,
    runtimeAdapter: runtimeAdapter.adapter,
    workerSafetyGate: {
      enforceBeforeDispatch: vi.fn(async () => createWorkerBaselineLock())
    },
    zeroDaySecurityLayer: {
      augmentLock: vi.fn(async (lock: WorkerBaselineLock) => lock)
    },
    integrationGate: new IntegrationGate({
      expectedProfile: VERIFIED_CLAUDE_RUNTIME_CAPABILITY_PROFILE,
      eventPublisher: options.eventPublisher,
      now: () => FIXED_NOW
    }),
    constraintProxy: {
      assertNoViolation: vi.fn(async () => undefined)
    },
    dirtyStatePanicService,
    eventNormalizer: {
      normalize: vi.fn(async () => null),
      clearSessionState: vi.fn()
    },
    generateWorkerRunId: () => "worker-run-hard-stale",
    now: () => FIXED_NOW
  });

  return {
    dispatch: serialDelegationService.dispatch.bind(serialDelegationService),
    runtimeAdapterSpies: runtimeAdapter.spies
  };
}

function createIgnoreDriftSerialDelegationService(options: {
  readonly eventPublisher?: EventPublisher;
  readonly workerRunRepo?: SqliteWorkerRunRepo;
}): Pick<SerialDelegationService, "dispatch"> & {
  readonly runtimeAdapterSpies: {
    readonly createSession: ReturnType<typeof vi.fn>;
    readonly prompt: ReturnType<typeof vi.fn>;
  };
} {
  if (options.eventPublisher === undefined || options.workerRunRepo === undefined) {
    return {
      dispatch: vi.fn(async () => {
        throw new Error("createIgnoreDriftSerialDelegationService requires eventPublisher and workerRunRepo");
      }),
      runtimeAdapterSpies: {
        createSession: vi.fn(),
        prompt: vi.fn()
      }
    };
  }

  const runtimeAdapter = createRuntimeAdapter();
  const workerRunLifecycle = new WorkerRunLifecycleService({
    repo: options.workerRunRepo,
    eventPublisher: options.eventPublisher,
    now: () => FIXED_NOW
  });
  const dirtyStatePanicService = {
    triggerPanic: vi.fn(
      async (params: {
        workerRunId: string;
        trigger: string;
        panicSource: string;
        summary: string;
        affectedScope: readonly { entity_type: string; entity_id: string }[];
      }) =>
        await workerRunLifecycle.freeze(params.workerRunId, params.panicSource, params.summary)
    )
  };
  const serialDelegationService = new SerialDelegationService({
    workerRunLifecycle,
    workerRunRepo: options.workerRunRepo,
    runtimeAdapter: runtimeAdapter.adapter,
    workerSafetyGate: {
      enforceBeforeDispatch: vi.fn(async () => createWorkerBaselineLock())
    },
    zeroDaySecurityLayer: {
      augmentLock: vi.fn(async (lock: WorkerBaselineLock) => lock)
    },
    integrationGate: new IntegrationGate({
      expectedProfile: VERIFIED_CLAUDE_RUNTIME_CAPABILITY_PROFILE,
      eventPublisher: options.eventPublisher,
      now: () => FIXED_NOW
    }),
    constraintProxy: {
      assertNoViolation: vi.fn(async () => undefined)
    },
    dirtyStatePanicService,
    eventNormalizer: {
      normalize: vi.fn(async () => null),
      clearSessionState: vi.fn()
    },
    generateWorkerRunId: () => "worker-run-ignore-drift",
    now: () => FIXED_NOW
  });

  return {
    dispatch: serialDelegationService.dispatch.bind(serialDelegationService),
    runtimeAdapterSpies: runtimeAdapter.spies
  };
}

function createRuntimeAdapter(
  capabilitiesOverrides: Partial<RuntimeCapabilities> = {}
): {
  readonly adapter: AgentRuntimePort;
  readonly spies: {
    readonly createSession: ReturnType<typeof vi.fn>;
    readonly prompt: ReturnType<typeof vi.fn>;
  };
} {
  const session: RuntimeSession = { session_id: "worker-session-1" };
  const capabilities: RuntimeCapabilities = {
    supports_resume: false,
    supports_interrupt: true,
    supports_streaming_updates: true,
    supports_tool_events: false,
    supports_permission_requests: false,
    supports_artifact_events: true,
    supports_terminal_events: false,
    ...capabilitiesOverrides
  };
  const createSession = vi.fn(async (_config: RuntimeSessionConfig) => session);
  const prompt = vi.fn(async () => undefined);

  return {
    adapter: {
      kind: "test-runtime",
      getCapabilities: () => capabilities,
      createSession,
      prompt,
      cancel: vi.fn(
        async (sessionId: string): Promise<RuntimeCancelResult> => ({
          session_id: sessionId,
          status: "already_finished"
        })
      ),
      onEvent: () => () => undefined
    },
    spies: {
      createSession,
      prompt
    }
  };
}

function createDispatchPayload(overrides: Partial<ReturnType<typeof createDispatchPayloadBase>> = {}) {
  return {
    ...createDispatchPayloadBase(),
    ...overrides
  };
}

function createDispatchPayloadBase() {
  return {
    engineClass: "coding_engine" as const,
    subtaskDescription: "Investigate runtime drift.",
    localSurfaceRef: "surface://principal/worker-dispatch",
    localEvidencePointer: "evidence://principal/worker-dispatch",
    restrictedToolSet: ["read_file", "exec_shell"],
    localBudget: {
      max_worker_delegations: 1,
      max_tool_calls: 3,
      max_output_tokens: 2048,
      max_wall_time_ms: 120000
    },
    agreedReturnFormat: {
      allowed_return_kinds: ["analysis_note", "verification_result"],
      requires_structured_summary: true
    },
    principalSecuritySnapshot: {
      governance_lease_ref: "lease://principal/worker-dispatch",
      hard_constraint_refs: ["constraint://worker-dispatch"],
      denied_tool_categories: ["network"]
    },
    sessionConfig: createSessionConfig(),
    prompt: "Investigate the drift and report the cause."
  };
}

function createSessionConfig(): RuntimeSessionConfig {
  return {
    role: "worker",
    workspace_id: "workspace-placeholder",
    run_id: "run-placeholder",
    cwd: "/workspace",
    writable_roots: ["/workspace"],
    tool_profile: "conversation_engine",
    allowed_mcp_servers: ["github"],
    sandbox_policy: "workspace_write",
    permission_policy: "ask",
    network_policy: "restricted"
  };
}

async function waitForExpectation(
  assertion: () => void,
  timeoutMs = 1000,
  intervalMs = 10
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }

  if (lastError instanceof Error) {
    throw lastError;
  }

  throw new Error("Timed out while waiting for expected assertion to pass.");
}

function createWorkerRun(overrides: Partial<DelegatedWorkerRun> = {}): DelegatedWorkerRun {
  return {
    worker_run_id: overrides.worker_run_id ?? "worker-route-1",
    principal_run_id: overrides.principal_run_id ?? "principal-run-1",
    workspace_id: overrides.workspace_id ?? "workspace-1",
    requesting_run_id: overrides.requesting_run_id ?? "principal-run-1",
    engine_class: overrides.engine_class ?? "coding_engine",
    state: overrides.state ?? "init",
    subtask_description: overrides.subtask_description ?? "Investigate runtime drift.",
    local_surface_ref: overrides.local_surface_ref ?? "surface://principal/worker-dispatch",
    local_evidence_pointer: overrides.local_evidence_pointer ?? "evidence://principal/worker-dispatch",
    restricted_tool_set: overrides.restricted_tool_set ?? ["read_file", "exec_shell"],
    local_budget:
      overrides.local_budget ?? {
        max_worker_delegations: 1,
        max_tool_calls: 3,
        max_output_tokens: 2048,
        max_wall_time_ms: 120000
      },
    agreed_return_format:
      overrides.agreed_return_format ?? {
        allowed_return_kinds: ["analysis_note", "verification_result"],
        requires_structured_summary: true
      },
    principal_security_snapshot:
      overrides.principal_security_snapshot ?? {
        governance_lease_ref: "lease://principal/worker-dispatch",
        hard_constraint_refs: ["constraint://worker-dispatch"],
        denied_tool_categories: ["network"]
      },
    created_at: overrides.created_at ?? FIXED_NOW,
    updated_at: overrides.updated_at ?? FIXED_NOW
  };
}

function createWorkerBaselineLock(overrides: Partial<WorkerBaselineLock> = {}): WorkerBaselineLock {
  return {
    lock_id: "lock-worker-dispatch-1",
    workspace_id: "workspace-1",
    hard_constraint_refs: ["constraint://worker-dispatch"],
    denied_tool_categories: ["network"],
    hazard_object_refs: [],
    hard_stop_refs: [],
    assembled_at: FIXED_NOW,
    ...overrides
  };
}

function resolveStaticWorkerDispatchFragmentId(workspaceId: string, content: string): string {
  return `constitutional://${workspaceId}/hard_constraint/system.worker_dispatch-${createHash("sha256")
    .update(content)
    .digest("hex")
    .slice(0, 12)}`;
}

async function createWorkspace(
  app: ReturnType<typeof createApp>,
  name: string,
  protectedHeaders: Record<string, string> = {}
): Promise<{ readonly workspace_id: string }> {
  const response = await app.request("/workspaces", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...protectedHeaders
    },
    body: JSON.stringify({
      name,
      root_path: `/tmp/${name}`,
      workspace_kind: WorkspaceKind.LOCAL_REPO
    })
  });

  expect(response.status).toBe(201);
  const body = (await response.json()) as any;
  const workspace = body.data;
  await configureWorkspacePrincipalCodingEngine(app, workspace.workspace_id, protectedHeaders);
  return workspace;
}

async function createRun(
  app: ReturnType<typeof createApp>,
  workspaceId: string,
  title: string,
  protectedHeaders: Record<string, string> = {}
): Promise<string> {
  const response = await app.request(`/workspaces/${workspaceId}/runs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...protectedHeaders
    },
    body: JSON.stringify({
      title,
      goal: null,
      run_mode: "chat"
    })
  });

  expect(response.status).toBe(201);
  const body = (await response.json()) as any;
  return body.data.run_id as string;
}

interface ParsedSseEvent {
  readonly id: string;
  readonly event: string;
  readonly data: any;
}

function createSseClient(response: Response): SseTestClient {
  if (response.body === null) {
    throw new Error("Expected SSE response body");
  }

  return new SseTestClient(response.body.getReader());
}

class SseTestClient {
  private readonly decoder = new TextDecoder();
  private buffer = "";

  public constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  public async readEvent(timeoutMs = 2000): Promise<ParsedSseEvent> {
    while (true) {
      const delimiter = this.buffer.indexOf("\n\n");
      if (delimiter >= 0) {
        const frame = this.buffer.slice(0, delimiter);
        this.buffer = this.buffer.slice(delimiter + 2);
        return parseSseFrame(frame);
      }

      const chunk = await readWithTimeout(this.reader, timeoutMs);

      if (chunk.done) {
        throw new Error("SSE stream closed before next event");
      }

      this.buffer += this.decoder.decode(chunk.value, { stream: true });
    }
  }

  public async close(): Promise<void> {
    await this.reader.cancel();
  }
}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for SSE chunk after ${timeoutMs}ms`));
    }, timeoutMs);

    reader.read().then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function parseSseFrame(frame: string): ParsedSseEvent {
  let id = "";
  let event = "message";
  const dataLines: string[] = [];

  for (const rawLine of frame.split("\n")) {
    const line = rawLine.replace(/\r$/, "");

    if (line.startsWith("id:")) {
      id = line.slice(3).trim();
      continue;
    }

    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
      continue;
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
  }

  const dataText = dataLines.join("\n");

  return {
    id,
    event,
    data: dataText.length === 0 ? null : parseSseData(dataText)
  };
}

function parseSseData(dataText: string): Record<string, unknown> {
  try {
    return JSON.parse(dataText) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Failed to parse SSE data: ${dataText}`, {
      cause: error instanceof Error ? error : undefined
    });
  }
}

async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 1000
): Promise<void> {
  const startedAt = Date.now();

  while (!(await condition())) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Condition was not met within ${timeoutMs}ms`);
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function readEventsByType(
  sse: SseTestClient,
  eventTypes: readonly string[],
  maxReads = 12
): Promise<readonly ParsedSseEvent[]> {
  const remaining = new Set(eventTypes);
  const matched: ParsedSseEvent[] = [];

  for (let index = 0; index < maxReads && remaining.size > 0; index += 1) {
    const event = await sse.readEvent();

    if (!remaining.has(event.event)) {
      continue;
    }

    matched.push(event);
    remaining.delete(event.event);
  }

  if (remaining.size > 0) {
    throw new Error(`Did not receive expected SSE events: ${[...remaining].join(", ")}`);
  }

  return matched;
}
