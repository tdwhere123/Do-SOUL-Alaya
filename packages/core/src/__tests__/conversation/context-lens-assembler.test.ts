import { describe, expect, it, vi } from "vitest";
import {
  ClaimKind,
  ControlPlaneObjectKind,
  EnforcementLevel,
  MemoryDimension,
  ObjectKind,
  OriginTier,
  RecallContextEventType,
  BudgetEventType,
  PrecedenceBasis,
  RetentionPolicy,
  RuntimeMode,
  ScopeClass,
  canonicalGovernanceSubject,
  type ClaimForm,
  type EventLogEntry,
  type MemoryEntry,
  type RecallPolicy,
  type SessionOverride,
  type Slot,
  type TaskObjectSurface
} from "@do-soul/alaya-protocol";
import type { RecallCandidate } from "../../recall/recall-service.js";
import {
  ContextLensAssembler,
  type LensAssemblerDependencies
} from "../../conversation/context-lens-assembler.js";

const NOW = "2026-03-23T10:00:00.000Z";
const EXPIRY = "2026-03-23T10:30:00.000Z";
const TASK_SURFACE_ID = "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca";
const PROJECT_MEMORY_ID = "9d599a9a-4940-4f23-a88e-0149f82ab021";
const GLOBAL_MEMORY_ID = "044e4071-26af-4d75-9141-416bf414b6ac";
const CLAIM_ID = "dd7441d2-c7e6-45e7-98f0-b77e0e4bf460";
const SLOT_ID = "b1c61b13-69a1-49d1-9ca9-98c11e5723d0";
const RECALL_POLICY_ID = "cb48e1ff-4c8b-4dad-87fd-6ceb30f3a2fb";

describe("context lens assembler", () => {
  it("assembles task-surface entries, strict winners, recalled memories, evidence pointers, and audit event", async () => {
    const dependencies = createDependencies();
    const assembler = new ContextLensAssembler(dependencies);

    const result = await assembler.assemble({
      run: {
        run_id: "run-1",
        workspace_id: "workspace-1",
        run_mode: "chat",
        title: "Main Run"
      },
      surfaceId: "surface://chat/main",
      displayName: "Implement ContextLens"
    });

    expect(result.contextLens.not_a_priority_source).toBe(true);
    expect(result.contextLens.object_kind).toBe(ControlPlaneObjectKind.CONTEXT_LENS);
    expect(result.contextLens.lens_entries.map((entry) => entry.object_kind)).toEqual([
      ControlPlaneObjectKind.TASK_OBJECT_SURFACE,
      ControlPlaneObjectKind.TASK_OBJECT_SURFACE,
      ObjectKind.CLAIM_FORM,
      ObjectKind.MEMORY_ENTRY,
      ObjectKind.MEMORY_ENTRY,
      ObjectKind.EVIDENCE_CAPSULE
    ]);
    expect(result.contextLens.lens_entries[2]).toMatchObject({
      object_id: CLAIM_ID,
      relevance_score: 1,
      manifestation: "full_eligible"
    });
    expect(result.contextLens.lens_entries[5]).toMatchObject({
      object_kind: "evidence_capsule",
      manifestation: "hint"
    });

    expect(result.workingProjection.entries).toEqual([
      expect.objectContaining({
        object_id: TASK_SURFACE_ID,
        object_kind: "task_object_surface",
        content_snapshot: "Goal: Implement ContextLens"
      }),
      expect.objectContaining({
        object_id: TASK_SURFACE_ID,
        object_kind: "task_object_surface",
        content_snapshot: "Surface analyze: Implement ContextLens"
      }),
      expect.objectContaining({
        object_id: CLAIM_ID,
        object_kind: "claim_form",
        content_snapshot: "Always run pnpm commands from the workspace root."
      }),
      expect.objectContaining({
        object_id: PROJECT_MEMORY_ID,
        object_kind: "memory_entry",
        content_snapshot: "Use pnpm for workspace commands."
      }),
      expect.objectContaining({
        object_id: GLOBAL_MEMORY_ID,
        object_kind: "memory_entry",
        content_snapshot: "Prefer deterministic tests."
      }),
      expect.objectContaining({
        object_id: "evidence-1",
        object_kind: "evidence_capsule",
        content_snapshot: "[evidence ref: evidence-1]"
      })
    ]);
    expect(result.workingProjection.total_token_estimate).toBe(
      result.workingProjection.entries.reduce((sum, entry) => sum + entry.token_estimate, 0)
    );
    expect(result.workingProjection.recall_policy_ref).toBe(RECALL_POLICY_ID);
    expect(assembler.getLastLens("run-1")).toEqual(result.contextLens);
    expect(assembler.getLastLens("missing-run")).toBeNull();
    expect(dependencies.claimRepo.findByIds).toHaveBeenCalledWith([CLAIM_ID]);
    expect(dependencies.recallService.buildDefaultPolicy).toHaveBeenCalledWith("analyze", TASK_SURFACE_ID);

    expect(dependencies.eventLogRepo.append).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: RecallContextEventType.SOUL_CONTEXT_LENS_ASSEMBLED,
        entity_type: "context_lens",
        run_id: "run-1",
        workspace_id: "workspace-1",
        payload_json: expect.objectContaining({
          runtime_id: result.contextLens.runtime_id,
          task_surface_ref: TASK_SURFACE_ID,
          lens_entry_count: 6,
          total_token_estimate: result.workingProjection.total_token_estimate,
          run_id: "run-1",
          workspace_id: "workspace-1",
          occurred_at: NOW
        })
      })
    );
  });

  it("prepends session overrides and exposes correction content in the working projection", async () => {
    const override = {
      runtime_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      object_kind: ControlPlaneObjectKind.SESSION_OVERRIDE,
      task_surface_ref: null,
      expires_at: EXPIRY,
      derived_from: null,
      retention_policy: RetentionPolicy.SESSION_ONLY,
      scope: "session_only",
      target_object: "memory:build-style",
      correction: "Use pnpm instead of npm.",
      priority: 5
    } satisfies SessionOverride;
    const overrideService = {
      getActiveFor: vi.fn(async () => [override])
    };
    const dependencies = createDependencies({
      overrideService
    });
    const assembler = new ContextLensAssembler(dependencies);

    const result = await assembler.assemble({
      run: {
        run_id: "run-with-override",
        workspace_id: "workspace-1",
        run_mode: "build",
        title: "Override Run"
      },
      surfaceId: "surface://chat/main",
      displayName: "Follow corrected guidance"
    });

    expect(overrideService.getActiveFor).toHaveBeenCalledWith("run-with-override");
    expect(result.contextLens.lens_entries[0]).toMatchObject({
      object_id: override.runtime_id,
      object_kind: ControlPlaneObjectKind.SESSION_OVERRIDE,
      relevance_score: 1,
      manifestation: "full_eligible"
    });
    expect(result.contextLens.lens_entries.slice(1, 3).map((entry) => entry.object_kind)).toEqual([
      ControlPlaneObjectKind.TASK_OBJECT_SURFACE,
      ControlPlaneObjectKind.TASK_OBJECT_SURFACE
    ]);
    expect(result.workingProjection.entries[0]).toMatchObject({
      object_id: override.runtime_id,
      object_kind: ControlPlaneObjectKind.SESSION_OVERRIDE,
      content_snapshot: "Override memory:build-style: Use pnpm instead of npm."
    });
    expect(dependencies.eventLogRepo.append).toHaveBeenCalledWith(
      expect.objectContaining({
        payload_json: expect.objectContaining({
          lens_entry_count: 7
        })
      })
    );
  });

  it("falls back to full global candidate content when no local memory row exists", async () => {
    const globalContent = "Shared global operating procedure ".repeat(12).trim();
    const dependencies = createDependencies({
      memoryRepo: {
        findById: vi.fn(async (objectId: string) => (objectId === PROJECT_MEMORY_ID ? createMemoryEntry({
          object_id: PROJECT_MEMORY_ID,
          scope_class: ScopeClass.PROJECT,
          content: "Use pnpm for workspace commands.",
          evidence_refs: ["evidence-1"],
          activation_score: 0.92,
          manifestation_state: "full_eligible"
        }) : null))
      },
      recallService: {
        recall: vi.fn(async () =>
          createRecallResult([
            createProjectCandidate(),
            Object.freeze({
              object_id: GLOBAL_MEMORY_ID,
              object_kind: "memory_entry" as const,
              activation_score: 0.95,
              relevance_score: 0.95,
              content_preview: globalContent,
              token_estimate: Math.ceil(globalContent.length / 4),
              manifestation: "full_eligible" as const,
              dimension: MemoryDimension.PREFERENCE,
              scope_class: ScopeClass.GLOBAL_DOMAIN,
              origin_plane: "global" as const
            })
          ])
        ),
        buildDefaultPolicy: vi.fn((strategy: "chat" | "analyze" | "build" | "govern", taskSurfaceRef: string) =>
          createRecallPolicy(taskSurfaceRef, strategy)
        )
      }
    });
    const assembler = new ContextLensAssembler(dependencies);

    const result = await assembler.assemble({
      run: {
        run_id: "run-global-fallback",
        workspace_id: "workspace-1",
        run_mode: "chat",
        title: "Global fallback"
      },
      surfaceId: "surface://chat/main",
      displayName: "Load global fallback"
    });

    expect(result.workingProjection.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          object_id: GLOBAL_MEMORY_ID,
          object_kind: "memory_entry",
          content_snapshot: globalContent
        })
      ])
    );
  });

  it("renders a hint-manifestation memory as a bare ref but an excerpt as body content — the over-surface gap a fail-closed ceiling must not cross", async () => {
    // invariant: at the lens surface hint = `[memory ref: <id>]` (zero body) and
    // excerpt = a body fragment. This is WHY the governance-read failsafe must cap
    // to hint, not excerpt: capping a true-hint ceiling to excerpt over-surfaces a
    // body fragment for a memory whose true ceiling is a bare ref.
    // see also: conversation/context-lens-assembler.ts resolveContentSnapshot,
    //   path-graph/path-manifestation-policy.ts GOVERNANCE_CEILING_FAILSAFE_BAND.
    const longBody =
      "Sensitive deployment rollback body that a bare hint ref must never expose, ".repeat(4).trim();
    const memory = createMemoryEntry({
      object_id: GLOBAL_MEMORY_ID,
      scope_class: ScopeClass.GLOBAL_DOMAIN,
      content: longBody,
      evidence_refs: [],
      activation_score: 0.95,
      manifestation_state: "full_eligible"
    });
    const candidateAt = (manifestation: "hint" | "excerpt"): Readonly<RecallCandidate> =>
      Object.freeze({
        object_id: GLOBAL_MEMORY_ID,
        object_kind: "memory_entry" as const,
        activation_score: 0.95,
        relevance_score: 0.95,
        // content_preview is the excerpt-band body fragment served at the lens;
        // for the hint band the lens ignores it and emits a bare ref.
        content_preview: longBody.slice(0, 157) + "...",
        token_estimate: Math.ceil(longBody.length / 4),
        manifestation,
        dimension: MemoryDimension.PREFERENCE,
        scope_class: ScopeClass.GLOBAL_DOMAIN,
        origin_plane: "global" as const
      });
    const snapshotFor = async (manifestation: "hint" | "excerpt"): Promise<string | undefined> => {
      const dependencies = createDependencies({
        memoryRepo: {
          findById: vi.fn(async (objectId: string) => (objectId === GLOBAL_MEMORY_ID ? memory : null))
        },
        recallService: {
          recall: vi.fn(async () => createRecallResult([candidateAt(manifestation)])),
          buildDefaultPolicy: vi.fn((strategy: "chat" | "analyze" | "build" | "govern", taskSurfaceRef: string) =>
            createRecallPolicy(taskSurfaceRef, strategy)
          )
        }
      });
      const assembler = new ContextLensAssembler(dependencies);
      const result = await assembler.assemble({
        run: { run_id: `run-${manifestation}`, workspace_id: "workspace-1", run_mode: "chat", title: "Surface test" },
        surfaceId: "surface://chat/main",
        displayName: "Surface a governed memory"
      });
      return result.workingProjection.entries.find((entry) => entry.object_id === GLOBAL_MEMORY_ID)?.content_snapshot;
    };

    const hintSnapshot = await snapshotFor("hint");
    const excerptSnapshot = await snapshotFor("excerpt");
    // hint: a bare ref, ZERO body — never an over-surface for any governance class.
    expect(hintSnapshot).toBe(`[memory ref: ${GLOBAL_MEMORY_ID}]`);
    expect(hintSnapshot).not.toContain("Sensitive deployment rollback body");
    // excerpt: a body fragment — over-surfaces a memory whose true ceiling is hint.
    expect(excerptSnapshot).toContain("Sensitive deployment rollback body");
    expect(excerptSnapshot).not.toBe(`[memory ref: ${GLOBAL_MEMORY_ID}]`);
  });

  it("warns once when overrideService is omitted", async () => {
    const warn = vi.fn();
    const assembler = new ContextLensAssembler(
      createDependencies({
        overrideService: undefined,
        warn
      })
    );

    await assembler.assemble({
      run: {
        run_id: "run-missing-override-service",
        workspace_id: "workspace-1",
        run_mode: "chat",
        title: "Missing overrides"
      },
      surfaceId: "surface://chat/main",
      displayName: "Assemble once"
    });
    await assembler.assemble({
      run: {
        run_id: "run-missing-override-service-2",
        workspace_id: "workspace-1",
        run_mode: "chat",
        title: "Missing overrides twice"
      },
      surfaceId: "surface://chat/main",
      displayName: "Assemble twice"
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "[ContextLensAssembler] overrideService missing; session overrides will not be projected.",
      expect.objectContaining({
        workspaceId: "workspace-1"
      })
    );
  });

  it("uses the resolved task-surface surface kind when deriving recall strategy", async () => {
    const recall = vi.fn(async () => createRecallResult([]));
    const resolveStrategy = vi.fn((surfaceKind: string) => (surfaceKind === "build" ? "build" : "chat"));
    const dependencies = createDependencies({
      recallService: {
        recall,
        buildDefaultPolicy: vi.fn((strategy: "chat" | "analyze" | "build" | "govern", taskSurfaceRef: string) =>
          createRecallPolicy(taskSurfaceRef, strategy)
        )
      },
      taskSurfaceBuilder: {
        build: vi.fn(async ({ displayName }) => createTaskSurface(displayName ?? "Ship it", "build")),
        resolveStrategy
      },
      slotRepo: {
        findByWorkspace: vi.fn(async () => [])
      }
    });
    const assembler = new ContextLensAssembler(dependencies);

    await assembler.assemble({
      run: {
        run_id: "run-chat",
        workspace_id: "workspace-1",
        run_mode: "chat",
        title: "Chat Run"
      },
      surfaceId: "surface://chat/main",
      displayName: "Ship it"
    });

    expect(resolveStrategy).toHaveBeenCalledWith("build");
    expect(recall).toHaveBeenCalledWith(
      expect.objectContaining({
        strategy: "build"
      })
    );
  });

  it("assembles broader lenses for analyze than build", async () => {
    const dependencies = createDependencies({
      recallService: {
        recall: vi.fn(async ({ strategy }) =>
          strategy === "analyze"
            ? createRecallResult([createProjectCandidate(), createGlobalCandidate()])
            : createRecallResult([createProjectCandidate()])
        ),
        buildDefaultPolicy: vi.fn((strategy: "chat" | "analyze" | "build" | "govern", taskSurfaceRef: string) =>
          createRecallPolicy(taskSurfaceRef, strategy)
        )
      },
      taskSurfaceBuilder: {
        build: vi.fn(async ({ run, displayName }) =>
          createTaskSurface(displayName ?? "Implement ContextLens", run.run_mode ?? "analyze")
        ),
        resolveStrategy: vi.fn((surfaceKind: string) => (surfaceKind === "build" ? "build" : "analyze"))
      }
    });
    const assembler = new ContextLensAssembler(dependencies);

    const analyzeLens = await assembler.assemble({
      run: {
        run_id: "run-analyze",
        workspace_id: "workspace-1",
        run_mode: "analyze",
        title: "Analyze Run"
      },
      surfaceId: "surface://chat/main",
      displayName: "Analyze code paths"
    });
    const buildLens = await assembler.assemble({
      run: {
        run_id: "run-build",
        workspace_id: "workspace-1",
        run_mode: "build",
        title: "Build Run"
      },
      surfaceId: "surface://chat/main",
      displayName: "Ship code"
    });

    expect(analyzeLens.contextLens.lens_entries).toHaveLength(6);
    expect(buildLens.contextLens.lens_entries).toHaveLength(5);
    expect(
      analyzeLens.contextLens.lens_entries.filter((entry) => entry.object_kind === "memory_entry")
    ).toHaveLength(2);
    expect(
      buildLens.contextLens.lens_entries.filter((entry) => entry.object_kind === "memory_entry")
    ).toHaveLength(1);
  });

  it("keeps task-surface entries even when recall and slots are empty", async () => {
    const dependencies = createDependencies({
      recallService: {
        recall: vi.fn(async () => createRecallResult([])),
        buildDefaultPolicy: vi.fn((strategy: "chat" | "analyze" | "build" | "govern", taskSurfaceRef: string) =>
          createRecallPolicy(taskSurfaceRef, strategy)
        )
      },
      slotRepo: {
        findByWorkspace: vi.fn(async () => [])
      }
    });
    const assembler = new ContextLensAssembler(dependencies);

    const result = await assembler.assemble({
      run: {
        run_id: "run-empty",
        workspace_id: "workspace-1",
        run_mode: "chat",
        title: "Empty Run"
      },
      surfaceId: null,
      displayName: "Start from scratch"
    });

    expect(result.contextLens.lens_entries).toHaveLength(2);
    expect(result.contextLens.lens_entries.every((entry) => entry.object_kind === "task_object_surface")).toBe(true);
    expect(result.workingProjection.entries).toHaveLength(2);
  });

  it("does not cache a lens when the audit append fails", async () => {
    const dependencies = createDependencies({
      eventLogRepo: {
        append: vi.fn(async () => {
          throw new Error("append failed");
        }),
        queryByEntity: vi.fn(async () => [])
      }
    });
    const assembler = new ContextLensAssembler(dependencies);

    await expect(
      assembler.assemble({
        run: {
          run_id: "run-fail",
          workspace_id: "workspace-1",
          run_mode: "chat",
          title: "Failing Run"
        },
        surfaceId: null,
        displayName: "Should not cache"
      })
    ).rejects.toThrow("append failed");
    expect(assembler.getLastLens("run-fail")).toBeNull();
  });

  it("prunes expired cached lenses on read", async () => {
    let currentNow = NOW;
    const assembler = new ContextLensAssembler(
      createDependencies({
        now: () => currentNow
      })
    );

    await assembler.assemble({
      run: {
        run_id: "run-expiring",
        workspace_id: "workspace-1",
        run_mode: "chat",
        title: "Expiring Run"
      },
      surfaceId: null,
      displayName: "Remember then expire"
    });

    expect(assembler.getLastLens("run-expiring")).not.toBeNull();
    currentNow = "2026-03-23T10:31:00.000Z";
    expect(assembler.getLastLens("run-expiring")).toBeNull();
  });

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

function createDependencies(
  overrides: Partial<LensAssemblerDependencies> = {}
): LensAssemblerDependencies & {
  claimRepo: {
    findByIds: ReturnType<typeof vi.fn>;
  };
  eventLogRepo: {
    append: ReturnType<typeof vi.fn>;
    queryByEntity: ReturnType<typeof vi.fn>;
  };
  recallService: {
    recall: ReturnType<typeof vi.fn>;
    buildDefaultPolicy: ReturnType<typeof vi.fn>;
  };
} {
  const projectMemory = createMemoryEntry({
    object_id: PROJECT_MEMORY_ID,
    scope_class: ScopeClass.PROJECT,
    content: "Use pnpm for workspace commands.",
    evidence_refs: ["evidence-1"],
    activation_score: 0.92,
    manifestation_state: "full_eligible"
  });
  const globalMemory = createMemoryEntry({
    object_id: GLOBAL_MEMORY_ID,
    scope_class: ScopeClass.GLOBAL_DOMAIN,
    content: "Prefer deterministic tests.",
    evidence_refs: [],
    activation_score: 0.51,
    manifestation_state: "excerpt"
  });
  const memories = new Map<string, MemoryEntry>([
    [projectMemory.object_id, projectMemory],
    [globalMemory.object_id, globalMemory]
  ]);
  const claim = createClaimForm();
  const claimById = new Map<string, ClaimForm>([[claim.object_id, claim]]);
  const eventLogRepo = {
    append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
      event_id: "evt-context-lens-1",
      created_at: NOW,
      revision: 0,
      ...entry
    })),
    queryByEntity: vi.fn(async () => [])
  };
  const recallService = {
    recall: vi.fn(async () => createRecallResult([createProjectCandidate(), createGlobalCandidate()])),
    buildDefaultPolicy: vi.fn((strategy: "chat" | "analyze" | "build" | "govern", taskSurfaceRef: string) =>
      createRecallPolicy(taskSurfaceRef, strategy)
    )
  };

  const defaultDependencies = {
    recallService,
    taskSurfaceBuilder: {
      build: vi.fn(async ({ displayName }) => createTaskSurface(displayName ?? "Implement ContextLens")),
      resolveStrategy: vi.fn((surfaceKind: string) => (surfaceKind === "build" ? "build" : "analyze"))
    },
    slotRepo: {
      findByWorkspace: vi.fn(async () => [createSlot()])
    },
    claimRepo: {
      findByIds: vi.fn(async (objectIds: readonly string[]) =>
        objectIds.flatMap((objectId) => {
          const loaded = claimById.get(objectId);
          return loaded === undefined ? [] : [loaded];
        })
      )
    },
    memoryRepo: {
      findById: vi.fn(async (objectId: string) => memories.get(objectId) ?? null)
    },
    eventLogRepo,
    warn: vi.fn(),
    generateRuntimeId: createRuntimeIdGenerator(),
    now: () => NOW
  } satisfies LensAssemblerDependencies;

  return {
    ...defaultDependencies,
    ...overrides
  } as LensAssemblerDependencies & {
    claimRepo: {
      findByIds: ReturnType<typeof vi.fn>;
    };
    eventLogRepo: {
      append: ReturnType<typeof vi.fn>;
      queryByEntity: ReturnType<typeof vi.fn>;
    };
    warn: ReturnType<typeof vi.fn>;
    recallService: {
      recall: ReturnType<typeof vi.fn>;
      buildDefaultPolicy: ReturnType<typeof vi.fn>;
    };
  };
}

function createRuntimeIdGenerator(nextIndex: () => number = createIncrementor()): () => string {
  return () => formatUuid(nextIndex());
}

function createIncrementor(): () => number {
  let index = 0;
  return () => index++;
}

function formatUuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function createTaskSurface(displayName: string, surfaceKind = "analyze"): TaskObjectSurface {
  return {
    runtime_id: TASK_SURFACE_ID,
    object_kind: ControlPlaneObjectKind.TASK_OBJECT_SURFACE,
    task_surface_ref: null,
    expires_at: EXPIRY,
    derived_from: "surface://chat/main",
    retention_policy: RetentionPolicy.SESSION_ONLY,
    surface_kind: surfaceKind,
    display_name: displayName,
    context_refs: []
  };
}

function createRecallPolicy(
  taskSurfaceRef: string,
  strategy: "chat" | "analyze" | "build" | "govern"
): RecallPolicy {
  return {
    runtime_id: RECALL_POLICY_ID,
    object_kind: ControlPlaneObjectKind.RECALL_POLICY,
    task_surface_ref: taskSurfaceRef,
    expires_at: EXPIRY,
    derived_from: taskSurfaceRef,
    retention_policy: RetentionPolicy.SESSION_ONLY,
    coarse_filter: {
      deterministic_match: {
        scope_filter: strategy === "build" ? [ScopeClass.PROJECT] : null,
        dimension_filter: null,
        domain_tag_filter: null
      },
      precomputed_rank: {
        max_candidates: strategy === "analyze" ? 50 : 20,
        min_activation_score: 0.1
      },
      semantic_supplement: {
        enabled: false,
        max_supplement: 0
      }
    },
    fine_assessment: {
      budgets: {
        max_total_tokens: 2000,
        max_entries: 10,
        per_dimension_limits: null
      },
      conflict_awareness: strategy !== "chat"
    }
  };
}

function createRecallResult(candidates: readonly Readonly<RecallCandidate>[]) {
  return Object.freeze({
    candidates: Object.freeze([...candidates]),
    active_constraints: Object.freeze([]),
    active_constraints_count: 0,
    total_scanned: candidates.length,
    coarse_filter_count: candidates.length,
    fine_assessment_count: candidates.length,
    degradation_reason: null,
    working_projection: null
  });
}

function createProjectCandidate() {
  return Object.freeze({
    object_id: PROJECT_MEMORY_ID,
    object_kind: "memory_entry" as const,
    activation_score: 0.92,
    relevance_score: 0.92,
    content_preview: "Use pnpm for workspace commands.",
    token_estimate: 8,
    manifestation: "full_eligible" as const,
    dimension: MemoryDimension.PROCEDURE,
    scope_class: ScopeClass.PROJECT,
    origin_plane: "workspace_local" as const
  });
}

function createGlobalCandidate() {
  return Object.freeze({
    object_id: GLOBAL_MEMORY_ID,
    object_kind: "memory_entry" as const,
    activation_score: 0.51,
    relevance_score: 0.51,
    content_preview: "Prefer deterministic tests.",
    token_estimate: 6,
    manifestation: "excerpt" as const,
    dimension: MemoryDimension.PREFERENCE,
    scope_class: ScopeClass.GLOBAL_DOMAIN,
    origin_plane: "workspace_local" as const
  });
}

function createMemoryEntry(
  overrides: Partial<MemoryEntry> & Pick<MemoryEntry, "object_id" | "scope_class" | "content">
): MemoryEntry {
  return {
    object_id: overrides.object_id,
    object_kind: ObjectKind.MEMORY_ENTRY,
    schema_version: 1,
    created_at: NOW,
    updated_at: NOW,
    created_by: "test",
    lifecycle_state: "active",
    dimension: overrides.dimension ?? MemoryDimension.PROCEDURE,
    source_kind: overrides.source_kind ?? "user",
    formation_kind: overrides.formation_kind ?? "explicit",
    scope_class: overrides.scope_class,
    content: overrides.content,
    domain_tags: overrides.domain_tags ?? [],
    evidence_refs: overrides.evidence_refs ?? [],
    workspace_id: overrides.workspace_id ?? "workspace-1",
    run_id: overrides.run_id ?? "run-1",
    surface_id: overrides.surface_id ?? null,
    storage_tier: overrides.storage_tier ?? "hot",
    activation_score: overrides.activation_score ?? 0.8,
    retention_score: overrides.retention_score ?? 0.8,
    manifestation_state: overrides.manifestation_state ?? "full_eligible",
    retention_state: overrides.retention_state ?? "working",
    decay_profile: overrides.decay_profile ?? "normal",
    confidence: overrides.confidence ?? 0.9,
    last_used_at: overrides.last_used_at ?? NOW,
    last_hit_at: overrides.last_hit_at ?? NOW,
    reinforcement_count: overrides.reinforcement_count ?? 1,
    contradiction_count: overrides.contradiction_count ?? 0,
    superseded_by: overrides.superseded_by ?? null
  };
}

function createClaimForm(): ClaimForm {
  return {
    object_id: CLAIM_ID,
    object_kind: ObjectKind.CLAIM_FORM,
    schema_version: 1,
    created_at: NOW,
    updated_at: NOW,
    created_by: "test",
    lifecycle_state: "active",
    governance_subject: canonicalGovernanceSubject("workflow", { area: "build" }),
    claim_kind: ClaimKind.CONSTRAINT,
    scope_class: ScopeClass.PROJECT,
    enforcement_level: EnforcementLevel.STRICT,
    origin_tier: OriginTier.USER_EXPLICIT,
    precedence_basis: PrecedenceBasis.USER_OVERRIDE,
    proposition_digest: "Always run pnpm commands from the workspace root.",
    evidence_refs: ["evidence-claim"],
    source_object_refs: [PROJECT_MEMORY_ID],
    workspace_id: "workspace-1",
    claim_status: "winner"
  };
}

function createSlot(): Slot {
  return {
    object_id: SLOT_ID,
    object_kind: ObjectKind.SLOT,
    schema_version: 1,
    created_at: NOW,
    updated_at: NOW,
    created_by: "test",
    lifecycle_state: "active",
    governance_subject: canonicalGovernanceSubject("workflow", { area: "build" }),
    claim_kind: ClaimKind.CONSTRAINT,
    scope_class: ScopeClass.PROJECT,
    winner_claim_id: CLAIM_ID,
    incumbent_since: NOW,
    flip_conditions: [],
    workspace_id: "workspace-1"
  };
}
