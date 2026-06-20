import { describe, expect, it, vi } from "vitest";
import { BudgetEventType, ObjectKind, RuntimeMode, ScopeClass, type EventLogEntry } from "@do-soul/alaya-protocol";
import { ContextLensAssembler } from "../../conversation/context-lens-assembler.js";
import { CLAIM_ID, GLOBAL_MEMORY_ID, PROJECT_MEMORY_ID, createDependencies, createGlobalCandidate, createMemoryEntry, createProjectCandidate, createRecallPolicy, createRecallResult, createRuntimeIdGenerator } from "./context-lens-assembler-test-fixtures.js";

describe("context lens assembler", () => {
it("evicts the oldest cached lens when the store exceeds its cap", async () => {
    let runtimeCounter = 0;
    const assembler = new ContextLensAssembler(
      createDependencies({
        generateRuntimeId: createRuntimeIdGenerator(() => runtimeCounter++)
      })
    );

    for (let index = 0; index <= 200; index += 1) {
      await assembler.assemble({
        run: {
          run_id: `run-${index}`,
          workspace_id: "workspace-1",
          run_mode: "chat",
          title: `Run ${index}`
        },
        surfaceId: null,
        displayName: `Run ${index}`
      });
    }

    expect(assembler.getLastLens("run-0")).toBeNull();
    expect(assembler.getLastLens("run-1")).not.toBeNull();
    expect(assembler.getLastLens("run-200")).not.toBeNull();
  });

it("clears cached lenses explicitly", async () => {
    const assembler = new ContextLensAssembler(createDependencies());

    await assembler.assemble({
      run: {
        run_id: "run-clear",
        workspace_id: "workspace-1",
        run_mode: "chat",
        title: "Clear Run"
      },
      surfaceId: null,
      displayName: "Remember then clear"
    });

    expect(assembler.getLastLens("run-clear")).not.toBeNull();
    assembler.clearLens("run-clear");
    expect(assembler.getLastLens("run-clear")).toBeNull();
  });

it("does not call the degradation pipeline when the projection is already within budget", async () => {
    const degradationPipeline = {
      assess: vi.fn(() => {
        throw new Error("degradation should not run");
      })
    };
    const dependencies = createDependencies({
      degradationPipeline
    });
    const assembler = new ContextLensAssembler(dependencies);

    await assembler.assemble({
      run: {
        run_id: "run-no-degradation",
        workspace_id: "workspace-1",
        run_mode: "chat",
        title: "Within Budget"
      },
      surfaceId: "surface://chat/main",
      displayName: "Stay small"
    });

    expect(degradationPipeline.assess).not.toHaveBeenCalled();
    expect(
      dependencies.eventLogRepo.append.mock.calls.some(
        ([entry]) => entry.event_type === BudgetEventType.SOUL_BUDGET_DEGRADED
      )
    ).toBe(false);
  });

it("uses tokensAfter without rebuilding when the degradation pipeline reports degraded false", async () => {
    const warn = vi.fn();
    const generateRuntimeId = vi.fn(createRuntimeIdGenerator());
    const degradationPipeline = {
      assess: vi.fn(({ contextLens, workingProjection }) => ({
        degraded: false,
        finalLens: contextLens,
        stepsApplied: [],
        tokensAfter: workingProjection.total_token_estimate,
        stillOverBudget: true,
        protectedObjectIds: [],
        droppedObjectIds: []
      }))
    };
    const dependencies = createDependencies({
      degradationPipeline,
      generateRuntimeId,
      warn,
      overrideService: {
        getActiveFor: vi.fn(async () => [])
      },
      recallService: {
        recall: vi.fn(async () => createRecallResult([createProjectCandidate(), createGlobalCandidate()])),
        buildDefaultPolicy: vi.fn((strategy: "chat" | "analyze" | "build" | "govern", taskSurfaceRef: string) => {
          const policy = createRecallPolicy(taskSurfaceRef, strategy);
          return {
            ...policy,
            fine_assessment: {
              ...policy.fine_assessment,
              budgets: {
                ...policy.fine_assessment.budgets,
                max_total_tokens: 10
              }
            }
          };
        })
      }
    });
    const assembler = new ContextLensAssembler(dependencies);

    const result = await assembler.assemble({
      run: {
        run_id: "run-degradation-noop",
        workspace_id: "workspace-1",
        run_mode: "chat",
        title: "No-op degradation"
      },
      surfaceId: "surface://chat/main",
      displayName: "Keep the original lens"
    });

    expect(degradationPipeline.assess).toHaveBeenCalledTimes(1);
    expect(generateRuntimeId).toHaveBeenCalledTimes(2);
    expect(result.contextLens.lens_entries.some((entry) => entry.object_kind === ObjectKind.MEMORY_ENTRY)).toBe(true);
    expect(result.workingProjection.total_token_estimate).toBeGreaterThan(10);
    expect(warn).toHaveBeenCalledWith(
      "[ContextLensAssembler] budget remains over limit after degradation.",
      expect.objectContaining({
        runId: "run-degradation-noop",
        budgetLimit: 10,
        tokensAfter: result.workingProjection.total_token_estimate,
        degraded: false
      })
    );
    expect(
      dependencies.eventLogRepo.append.mock.calls.some(
        ([entry]) => entry.event_type === BudgetEventType.SOUL_BUDGET_DEGRADED
      )
    ).toBe(false);
  });

it("rebuilds the working projection and emits a degraded event when degradation succeeds", async () => {
    const longProjectMemory = createMemoryEntry({
      object_id: PROJECT_MEMORY_ID,
      scope_class: ScopeClass.PROJECT,
      content: "P".repeat(600),
      evidence_refs: ["evidence-1"],
      activation_score: 0.92,
      manifestation_state: "full_eligible"
    });
    const longGlobalMemory = createMemoryEntry({
      object_id: GLOBAL_MEMORY_ID,
      scope_class: ScopeClass.GLOBAL_DOMAIN,
      content: "G".repeat(480),
      evidence_refs: [],
      activation_score: 0.51,
      manifestation_state: "excerpt"
    });
    const memoryRepo = {
      findById: vi.fn(async (objectId: string) => {
        if (objectId === PROJECT_MEMORY_ID) {
          return longProjectMemory;
        }

        if (objectId === GLOBAL_MEMORY_ID) {
          return longGlobalMemory;
        }

        return null;
      })
    };
    const degradationPipeline = {
      assess: vi.fn(({ contextLens }) => ({
        degraded: true,
        finalLens: {
          ...contextLens,
          lens_entries: contextLens.lens_entries.filter(
            (entry: (typeof contextLens.lens_entries)[number]) => entry.object_kind !== ObjectKind.MEMORY_ENTRY
          )
        },
        stepsApplied: [
          {
            kind: "soft_global_clean",
            object_ids_affected: [PROJECT_MEMORY_ID, GLOBAL_MEMORY_ID],
            tokens_freed: 200
          }
        ],
        tokensAfter: 40,
        stillOverBudget: false,
        protectedObjectIds: [CLAIM_ID],
        droppedObjectIds: [PROJECT_MEMORY_ID, GLOBAL_MEMORY_ID]
      }))
    };
    const dependencies = createDependencies({
      memoryRepo,
      degradationPipeline,
      recallService: {
        recall: vi.fn(async () => createRecallResult([createProjectCandidate(), createGlobalCandidate()])),
        buildDefaultPolicy: vi.fn((strategy: "chat" | "analyze" | "build" | "govern", taskSurfaceRef: string) => {
          const policy = createRecallPolicy(taskSurfaceRef, strategy);
          return {
            ...policy,
            fine_assessment: {
              ...policy.fine_assessment,
              budgets: {
                ...policy.fine_assessment.budgets,
                max_total_tokens: 80
              }
            }
          };
        })
      }
    });
    const assembler = new ContextLensAssembler(dependencies);

    const result = await assembler.assemble({
      run: {
        run_id: "run-degraded",
        workspace_id: "workspace-1",
        run_mode: "chat",
        title: "Needs degradation"
      },
      surfaceId: "surface://chat/main",
      displayName: "Trim context"
    });

    expect(degradationPipeline.assess).toHaveBeenCalledTimes(1);
    expect(result.contextLens.lens_entries.some((entry) => entry.object_kind === ObjectKind.MEMORY_ENTRY)).toBe(false);

    const appendedEntries = dependencies.eventLogRepo.append.mock.calls.map(
      (call) => call[0] as Omit<EventLogEntry, "event_id" | "created_at" | "revision">
    );
    const degradedEntry = appendedEntries.find(
      (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) =>
        entry.event_type === BudgetEventType.SOUL_BUDGET_DEGRADED
    );

    expect(degradedEntry).toBeDefined();
    expect(degradedEntry?.payload_json).toMatchObject({
      run_id: "run-degraded",
      workspace_id: "workspace-1",
      lens_runtime_id: result.contextLens.runtime_id,
      steps_applied: ["soft_global_clean"],
      tokens_after: result.workingProjection.total_token_estimate,
      budget_limit: 80,
      still_over_budget: false
    });
    expect(result.workingProjection.total_token_estimate).toBeLessThan(
      (degradedEntry?.payload_json as { tokens_before: number }).tokens_before
    );
  });

it("warns and returns the degraded lens when the budget remains over limit", async () => {
    const longProjectMemory = createMemoryEntry({
      object_id: PROJECT_MEMORY_ID,
      scope_class: ScopeClass.PROJECT,
      content: "P".repeat(600),
      evidence_refs: ["evidence-1"],
      activation_score: 0.92,
      manifestation_state: "full_eligible"
    });
    const longGlobalMemory = createMemoryEntry({
      object_id: GLOBAL_MEMORY_ID,
      scope_class: ScopeClass.GLOBAL_DOMAIN,
      content: "G".repeat(480),
      evidence_refs: [],
      activation_score: 0.51,
      manifestation_state: "full_eligible"
    });
    const memoryRepo = {
      findById: vi.fn(async (objectId: string) => {
        if (objectId === PROJECT_MEMORY_ID) {
          return longProjectMemory;
        }

        if (objectId === GLOBAL_MEMORY_ID) {
          return longGlobalMemory;
        }

        return null;
      })
    };
    const degradationPipeline = {
      assess: vi.fn(({ contextLens }) => ({
        degraded: true,
        finalLens: {
          ...contextLens,
          lens_entries: contextLens.lens_entries.map((entry: (typeof contextLens.lens_entries)[number]) =>
            entry.object_id === PROJECT_MEMORY_ID ? { ...entry, manifestation: "hint" as const } : entry
          )
        },
        stepsApplied: [
          {
            kind: "manifestation_downgrade_hint",
            object_ids_affected: [PROJECT_MEMORY_ID],
            tokens_freed: 100
          }
        ],
        tokensAfter: 120,
        stillOverBudget: true,
        protectedObjectIds: [CLAIM_ID],
        droppedObjectIds: []
      }))
    };
    const warn = vi.fn();
    const dependencies = createDependencies({
      memoryRepo,
      degradationPipeline,
      overrideService: {
        getActiveFor: vi.fn(async () => [])
      },
      warn,
      recallService: {
        recall: vi.fn(async () => createRecallResult([createProjectCandidate(), createGlobalCandidate()])),
        buildDefaultPolicy: vi.fn((strategy: "chat" | "analyze" | "build" | "govern", taskSurfaceRef: string) => {
          const policy = createRecallPolicy(taskSurfaceRef, strategy);
          return {
            ...policy,
            fine_assessment: {
              ...policy.fine_assessment,
              budgets: {
                ...policy.fine_assessment.budgets,
                max_total_tokens: 20
              }
            }
          };
        })
      }
    });
    const assembler = new ContextLensAssembler(dependencies);

    const result = await assembler.assemble({
      run: {
        run_id: "run-still-over-budget",
        workspace_id: "workspace-1",
        run_mode: "chat",
        title: "Still over budget"
      },
      surfaceId: "surface://chat/main",
      displayName: "Warn on overflow"
    });

    expect(degradationPipeline.assess).toHaveBeenCalledTimes(1);
    expect(result.contextLens.lens_entries.find((entry) => entry.object_id === PROJECT_MEMORY_ID)?.manifestation).toBe(
      "hint"
    );
    expect(warn).toHaveBeenCalledWith(
      "[ContextLensAssembler] budget remains over limit after degradation.",
      expect.objectContaining({
        runId: "run-still-over-budget",
        budgetLimit: 20,
        degraded: true
      })
    );
    expect((warn.mock.calls[0]?.[1] as { tokensAfter: number }).tokensAfter).toBeGreaterThan(20);
    expect(
      dependencies.eventLogRepo.append.mock.calls.some(
        ([entry]) => entry.event_type === BudgetEventType.SOUL_BUDGET_DEGRADED
      )
    ).toBe(true);
  });

it("broadcasts degraded events and declares bankruptcy when the lens remains over budget", async () => {
    const degradationPipeline = {
      assess: vi.fn(({ contextLens }) => ({
        degraded: true,
        finalLens: contextLens,
        stepsApplied: [
          {
            kind: "soft_global_clean",
            object_ids_affected: [PROJECT_MEMORY_ID],
            tokens_freed: 40
          }
        ],
        tokensAfter: 120,
        stillOverBudget: true,
        protectedObjectIds: [CLAIM_ID],
        droppedObjectIds: [PROJECT_MEMORY_ID]
      }))
    };
    const bankruptcyService = {
      declare: vi.fn(async () => ({
        state: {} as never,
        dossier: {} as never,
        proposal: {} as never
      }))
    };
    const dependencies = createDependencies({
      degradationPipeline,
      bankruptcyService,
      overrideService: {
        getActiveFor: vi.fn(async () => [])
      },
      recallService: {
        recall: vi.fn(async () => createRecallResult([createProjectCandidate(), createGlobalCandidate()])),
        buildDefaultPolicy: vi.fn((strategy: "chat" | "analyze" | "build" | "govern", taskSurfaceRef: string) => {
          const policy = createRecallPolicy(taskSurfaceRef, strategy);
          return {
            ...policy,
            fine_assessment: {
              ...policy.fine_assessment,
              budgets: {
                ...policy.fine_assessment.budgets,
                max_total_tokens: 20
              }
            }
          };
        })
      }
    });
    const assembler = new ContextLensAssembler(dependencies);

    await assembler.assemble({
      run: {
        run_id: "run-declare-bankruptcy",
        workspace_id: "workspace-1",
        run_mode: "chat",
        title: "Still over budget"
      },
      surfaceId: "surface://chat/main",
      displayName: "Declare bankruptcy",
      runtimeMode: RuntimeMode.FULL
    });

    expect(dependencies.eventLogRepo.append).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: BudgetEventType.SOUL_BUDGET_DEGRADED
      })
    );
    expect(bankruptcyService.declare).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-declare-bankruptcy",
        workspaceId: "workspace-1",
        triggerKind: "token_overflow",
        currentMode: RuntimeMode.FULL,
        protectedConstraints: [CLAIM_ID],
        droppedCandidates: [PROJECT_MEMORY_ID]
      })
    );
  });
});
