import { describe, expect, it, vi } from "vitest";
import { ControlPlaneObjectKind, MemoryDimension, ObjectKind, RecallContextEventType, RetentionPolicy, ScopeClass, type SessionOverride } from "@do-soul/alaya-protocol";
import type { RecallCandidate } from "../../recall/recall-service.js";
import { ContextLensAssembler, type LensAssemblerDependencies } from "../../conversation/context-lens-assembler.js";
import { NOW, EXPIRY, CLAIM_ID, GLOBAL_MEMORY_ID, PROJECT_MEMORY_ID, RECALL_POLICY_ID, TASK_SURFACE_ID, createDependencies, createGlobalCandidate, createMemoryEntry, createProjectCandidate, createRecallPolicy, createRecallResult, createTaskSurface } from "./context-lens-assembler-test-fixtures.js";

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
    expect(dependencies.claimRepo.findByIds).toHaveBeenCalledWith("workspace-1", [CLAIM_ID]);
    expect(dependencies.memoryRepo.findByIds).toHaveBeenCalledWith("workspace-1", [PROJECT_MEMORY_ID, GLOBAL_MEMORY_ID]);
    expect(dependencies.memoryRepo.findById).not.toHaveBeenCalled();
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

it("filters cross-workspace memories when using the single-id fallback loader", async () => {
    const crossWorkspaceMemoryId = "9d599a9a-4940-4f23-a88e-0149f82ab099";
    const crossWorkspaceMemory = createMemoryEntry({
      object_id: crossWorkspaceMemoryId,
      scope_class: ScopeClass.PROJECT,
      workspace_id: "workspace-2",
      content: "Foreign workspace memory."
    });
    const dependencies = createDependencies({
      recallService: {
        recall: vi.fn(async () => createRecallResult([
          {
            ...createProjectCandidate(),
            object_id: crossWorkspaceMemoryId
          } satisfies RecallCandidate
        ])),
        buildDefaultPolicy: vi.fn(() => createRecallPolicy(TASK_SURFACE_ID, "analyze"))
      },
      slotRepo: {
        findByWorkspace: vi.fn(async () => [])
      },
      memoryRepo: {
        findById: vi.fn(async () => crossWorkspaceMemory),
        findByIds: undefined
      } as unknown as LensAssemblerDependencies["memoryRepo"]
    });
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

    expect(result.workingProjection.entries).not.toContainEqual(
      expect.objectContaining({ object_id: crossWorkspaceMemoryId })
    );
    expect(dependencies.memoryRepo.findById).toHaveBeenCalledWith(crossWorkspaceMemoryId);
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
});
