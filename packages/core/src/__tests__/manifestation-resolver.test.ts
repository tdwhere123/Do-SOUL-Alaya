import { describe, expect, it, vi } from "vitest";
import {
  ControlPlaneObjectKind,
  ManifestationLevel,
  PathGovernanceClass,
  RetentionPolicy,
  RuntimeGovernanceEventType,
  serializePathAnchorRef,
  type ActivationCandidate,
  type EventLogEntry,
  type ManifestationBudgetConfig,
  type TaskObjectSurface
} from "@do-soul/alaya-protocol";

const NOW = "2026-04-17T09:00:00.000Z";

describe("ManifestationResolver", () => {
  it("uses default config, orders by score, assigns levels, and writes C-7 events", async () => {
    const deps = createDependencies({
      config: null
    });
    const service = await createService(deps);

    const decisions = await service.resolve({
      workspaceId: "workspace-1",
      runId: "run-1",
      candidates: [
        createCandidate({
          candidate_id: "candidate-stance",
          source_anchor: { kind: "object" as const, object_id: "object-stance" },
          target_anchor: { kind: "object" as const, object_id: "object-target-stance" },
          pressure: 0.2,
          confidence: 0.9
        }),
        createCandidate({
          candidate_id: "candidate-lens",
          source_anchor: { kind: "object" as const, object_id: "task-object-1" },
          target_anchor: { kind: "object" as const, object_id: "object-target-lens" },
          pressure: 0.9,
          confidence: 0.9
        }),
        createCandidate({
          candidate_id: "candidate-nudge",
          source_anchor: { kind: "object" as const, object_id: "object-nudge" },
          target_anchor: { kind: "object" as const, object_id: "object-target-nudge" },
          pressure: 0.7,
          confidence: 0.7
        })
      ],
      taskSurfaceRef: createTaskSurface(["task-object-1"])
    });

    expect(deps.budgetConfigProvider.getConfig).toHaveBeenCalledWith("workspace-1");
    expect(decisions.map((decision) => decision.candidate_id)).toEqual([
      "candidate-lens",
      "candidate-nudge",
      "candidate-stance"
    ]);
    expect(decisions.map((decision) => decision.assigned_level)).toEqual([
      ManifestationLevel.LENS_ENTRY,
      ManifestationLevel.DIALOGUE_NUDGE,
      ManifestationLevel.STANCE_BIAS
    ]);
    expect(decisions[0]).toMatchObject({
      reason: expect.stringContaining("lens_entry"),
      budget_remaining: {
        stance_bias: 10,
        dialogue_nudge: 3,
        lens_entry: 0
      }
    });
    expect(decisions[1]).toMatchObject({
      reason: expect.stringContaining("dialogue_nudge"),
      budget_remaining: {
        stance_bias: 10,
        dialogue_nudge: 2,
        lens_entry: 0
      }
    });
    expect(decisions[2]).toMatchObject({
      reason: expect.stringContaining("stance_bias"),
      budget_remaining: {
        stance_bias: 9,
        dialogue_nudge: 2,
        lens_entry: 0
      }
    });

    expect(deps.eventLogWriter.append).toHaveBeenCalledTimes(2);
    expect(deps.eventLogWriter.append).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        event_type: RuntimeGovernanceEventType.MANIFESTATION_BUDGET_EVALUATED,
        workspace_id: "workspace-1",
        run_id: "run-1",
        caused_by: "deterministic_rule",
        payload_json: {
          workspace_id: "workspace-1",
          run_id: "run-1",
          total_candidates: 3,
          stance_bias_assigned: 1,
          dialogue_nudge_assigned: 1,
          lens_entry_assigned: 1,
          discarded: 0,
          evaluated_at: NOW
        }
      })
    );
    expect(deps.eventLogWriter.append).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        event_type: RuntimeGovernanceEventType.MANIFESTATION_ESCALATION_DECIDED,
        workspace_id: "workspace-1",
        run_id: "run-1",
        caused_by: "deterministic_rule",
        payload_json: {
          workspace_id: "workspace-1",
          run_id: "run-1",
          decisions: [
            {
              candidate_id: "candidate-lens",
              assigned_level: ManifestationLevel.LENS_ENTRY,
              reason: decisions[0]?.reason
            },
            {
              candidate_id: "candidate-nudge",
              assigned_level: ManifestationLevel.DIALOGUE_NUDGE,
              reason: decisions[1]?.reason
            },
            {
              candidate_id: "candidate-stance",
              assigned_level: ManifestationLevel.STANCE_BIAS,
              reason: decisions[2]?.reason
            }
          ],
          decided_at: NOW
        }
      })
    );
  });

  it("downgrades and discards once manifestation budgets are exhausted", async () => {
    const deps = createDependencies({
      config: createBudgetConfig({
        stance_bias_cap: 1,
        dialogue_nudge_cap: 1,
        lens_entry_cap: 1
      })
    });
    const service = await createService(deps);

    const decisions = await service.resolve({
      workspaceId: "workspace-1",
      runId: "run-1",
      candidates: [
        createCandidate({
          candidate_id: "candidate-1",
          source_anchor: { kind: "object" as const, object_id: "task-object-1" },
          pressure: 0.95,
          confidence: 0.95
        }),
        createCandidate({
          candidate_id: "candidate-2",
          source_anchor: { kind: "object" as const, object_id: "task-object-1" },
          pressure: 0.9,
          confidence: 0.9
        }),
        createCandidate({
          candidate_id: "candidate-3",
          source_anchor: { kind: "object" as const, object_id: "task-object-1" },
          pressure: 0.85,
          confidence: 0.85
        }),
        createCandidate({
          candidate_id: "candidate-4",
          source_anchor: { kind: "object" as const, object_id: "task-object-1" },
          pressure: 0.8,
          confidence: 0.8
        })
      ],
      taskSurfaceRef: createTaskSurface(["task-object-1"])
    });

    expect(decisions.map((decision) => [decision.candidate_id, decision.assigned_level])).toEqual([
      ["candidate-1", ManifestationLevel.LENS_ENTRY],
      ["candidate-2", ManifestationLevel.DIALOGUE_NUDGE],
      ["candidate-3", ManifestationLevel.STANCE_BIAS],
      ["candidate-4", null]
    ]);
    expect(decisions[1]?.reason).toContain("lens_entry_budget_exhausted");
    expect(decisions[2]?.reason).toContain("dialogue_nudge_budget_exhausted");
    expect(decisions[3]?.reason).toContain("stance_bias_budget_exhausted");
  });

  it("blocks lens_entry when governance ceiling is below recall_allowed", async () => {
    const service = await createService(
      createDependencies({
        config: null
      })
    );

    const decisions = await service.resolve({
      workspaceId: "workspace-1",
      runId: "run-1",
      candidates: [
        createCandidate({
          candidate_id: "candidate-governance",
          source_anchor: { kind: "object" as const, object_id: "task-object-1" },
          pressure: 0.9,
          confidence: 0.95,
          governance_ceiling: PathGovernanceClass.ATTENTION_ONLY
        })
      ],
      taskSurfaceRef: createTaskSurface(["task-object-1"])
    });

    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.assigned_level).toBe(ManifestationLevel.DIALOGUE_NUDGE);
    expect(decisions[0]?.reason).toContain("governance_ceiling");
  });

  it("blocks lens_entry when taskSurfaceRef is null but still allows dialogue_nudge", async () => {
    const service = await createService(
      createDependencies({
        config: null
      })
    );

    const decisions = await service.resolve({
      workspaceId: "workspace-1",
      runId: "run-1",
      candidates: [
        createCandidate({
          candidate_id: "candidate-null-task-surface",
          source_anchor: { kind: "object" as const, object_id: "task-object-1" },
          pressure: 0.9,
          confidence: 0.95
        })
      ],
      taskSurfaceRef: null
    });

    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.assigned_level).toBe(ManifestationLevel.DIALOGUE_NUDGE);
    expect(decisions[0]?.reason).toContain("task_surface_ref_missing");
  });

  it("treats the canonical serialized path anchor identity as task coupling context", async () => {
    const service = await createService(
      createDependencies({
        config: null
      })
    );
    const sourceAnchor = {
      kind: "object_facet" as const,
      object_id: "task-object-1",
      facet_key: "acceptance_criteria"
    };

    const decisions = await service.resolve({
      workspaceId: "workspace-1",
      runId: "run-1",
      candidates: [
        createCandidate({
          candidate_id: "candidate-facet-coupled",
          source_anchor: sourceAnchor,
          pressure: 0.9,
          confidence: 0.95
        })
      ],
      taskSurfaceRef: createTaskSurface([serializePathAnchorRef(sourceAnchor)])
    });

    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.assigned_level).toBe(ManifestationLevel.LENS_ENTRY);
  });

  it("rejects malformed candidates before evaluation", async () => {
    const deps = createDependencies({
      config: null
    });
    const service = await createService(deps);

    await expect(
      service.resolve({
        workspaceId: "workspace-1",
        runId: "run-1",
        candidates: [{ candidate_id: "broken" } as unknown as ActivationCandidate],
        taskSurfaceRef: null
      })
    ).rejects.toThrow();
    expect(deps.eventLogWriter.append).not.toHaveBeenCalled();
  });

});

async function createService(deps: ReturnType<typeof createDependencies>) {
  const serviceModulePath = new URL("../manifestation-resolver.js", import.meta.url).href;
  const serviceModule = (await import(serviceModulePath)) as {
    ManifestationResolver: new (dependencies: Record<string, unknown>) => {
      resolve(params: {
        workspaceId: string;
        runId: string;
        candidates: readonly Readonly<ActivationCandidate>[];
        taskSurfaceRef: Readonly<TaskObjectSurface> | null;
      }): Promise<
        readonly Readonly<{
          candidate_id: string;
          assigned_level: ManifestationLevel | null;
          reason: string;
          budget_remaining: {
            stance_bias: number;
            dialogue_nudge: number;
            lens_entry: number;
          };
        }>[]
      >;
    };
  };

  return new serviceModule.ManifestationResolver({
    budgetConfigProvider: deps.budgetConfigProvider,
    eventLogWriter: deps.eventLogWriter,
    now: () => NOW
  });
}

function createDependencies(input: {
  config: Readonly<ManifestationBudgetConfig> | null;
}) {
  return {
    budgetConfigProvider: {
      getConfig: vi.fn(async () => input.config)
    },
    eventLogWriter: {
      append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
        event_id: `event-${Math.random()}`,
        created_at: NOW,
        revision: 0,
        ...entry
      }))
    }
  };
}

function createBudgetConfig(
  overrides: Partial<ManifestationBudgetConfig> = {}
): Readonly<ManifestationBudgetConfig> {
  return Object.freeze({
    workspace_id: "workspace-1",
    stance_bias_cap: 10,
    dialogue_nudge_cap: 3,
    lens_entry_cap: 1,
    escalation_policy: {
      nudge_min_pressure: 0.4,
      nudge_min_confidence: 0.5,
      lens_min_pressure: 0.7,
      lens_min_confidence: 0.7,
      lens_requires_task_coupling: true,
      lens_requires_governance_ceiling: true
    },
    updated_at: NOW,
    ...overrides
  });
}

function createTaskSurface(contextRefs: readonly string[]): Readonly<TaskObjectSurface> {
  return Object.freeze({
    runtime_id: "task-surface-1",
    object_kind: ControlPlaneObjectKind.TASK_OBJECT_SURFACE,
    task_surface_ref: null,
    expires_at: "2026-04-17T10:00:00.000Z",
    derived_from: null,
    retention_policy: RetentionPolicy.SESSION_ONLY,
    surface_kind: "build",
    display_name: "Implement manifestation budget",
    context_refs: Object.freeze([...contextRefs])
  });
}

function createCandidate(
  overrides: Partial<ActivationCandidate> = {}
): Readonly<ActivationCandidate> {
  return Object.freeze({
    candidate_id: "candidate-1",
    workspace_id: "workspace-1",
    run_id: "run-1",
    source_path_id: "path-1",
    source_anchor: {
      kind: "object" as const,
      object_id: "object-source"
    },
    target_anchor: {
      kind: "object" as const,
      object_id: "object-target"
    },
    why_now: "test candidate",
    effect_vector_snapshot: {
      salience: 0.75,
      recall_bias: 0.4,
      verification_bias: 0.6,
      unfinishedness_bias: 0.3,
      default_manifestation_preference: ManifestationLevel.STANCE_BIAS
    },
    pressure: 0.8,
    confidence: 0.8,
    governance_ceiling: PathGovernanceClass.RECALL_ALLOWED,
    created_at: NOW,
    ...overrides
  });
}
