import { vi } from "vitest";
import { ControlPlaneObjectKind, ManifestationLevel, PathGovernanceClass, RetentionPolicy, type ActivationCandidate, type EventLogEntry, type ManifestationBudgetConfig, type TaskObjectSurface } from "@do-soul/alaya-protocol";

export const NOW = "2026-04-17T09:00:00.000Z";

export async function createService(deps: ReturnType<typeof createDependencies>) {
  const serviceModulePath = new URL("../../manifestation/manifestation-resolver.js", import.meta.url).href;
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

export function createDependencies(input: {
  config: Readonly<ManifestationBudgetConfig> | null;
}) {
  return {
    budgetConfigProvider: {
      getConfig: vi.fn(async () => input.config)
    },
    eventLogWriter: {
      appendAtomically: vi.fn(async (
        entries: readonly Omit<EventLogEntry, "event_id" | "created_at" | "revision">[]
      ) => entries.map((entry) => ({
        event_id: `event-${Math.random()}`,
        created_at: NOW,
        revision: 0,
        ...entry
      })))
    }
  };
}

export function createBudgetConfig(
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

export function createTaskSurface(contextRefs: readonly string[]): Readonly<TaskObjectSurface> {
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

export function createCandidate(
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
