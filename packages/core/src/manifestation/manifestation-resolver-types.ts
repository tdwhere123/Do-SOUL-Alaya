import type {
  ActivationCandidate,
  EventLogEntry,
  ManifestationBudgetConfig,
  ManifestationDecision,
  ManifestationLevel as ManifestationLevelValue,
  TaskObjectSurface
} from "@do-soul/alaya-protocol";

export interface ManifestationBudgetConfigProviderPort {
  getConfig(workspaceId: string): Promise<Readonly<ManifestationBudgetConfig> | null>;
}

export interface ManifestationResolverEventLogWriterPort {
  append(entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry | Promise<EventLogEntry>;
}

export interface ManifestationResolverDependencies {
  readonly budgetConfigProvider: ManifestationBudgetConfigProviderPort;
  readonly eventLogWriter: ManifestationResolverEventLogWriterPort;
  readonly now?: () => string;
}

export interface ResolveManifestationParams {
  readonly workspaceId: string;
  readonly runId: string;
  readonly candidates: readonly Readonly<ActivationCandidate>[];
  readonly taskSurfaceRef: Readonly<TaskObjectSurface> | null;
}

export interface ManifestationBiasSidecarEntry {
  readonly candidate_id: string;
  readonly target_memory_object_id: string | null;
  readonly unfinishedness_bias: number;
  readonly pending_incomplete: boolean;
  readonly verification_bias: number;
}

export interface ResolveManifestationWithBiasResult {
  readonly decisions: readonly Readonly<ManifestationDecision>[];
  readonly biasSidecar: readonly Readonly<ManifestationBiasSidecarEntry>[];
}

export type BudgetState = Readonly<{
  stance_bias: number;
  dialogue_nudge: number;
  lens_entry: number;
}>;

export type BudgetAllocationResult = Readonly<{
  assignedLevel: ManifestationLevelValue | null;
  exhaustedLevels: readonly ManifestationLevelValue[];
  remainingBudget: BudgetState;
  governanceBlocked: boolean;
}>;

export type LensEligibility = {
  eligible: boolean;
  blockedReason: "task_surface_ref_missing" | "task_coupling" | "governance_ceiling" | null;
};
