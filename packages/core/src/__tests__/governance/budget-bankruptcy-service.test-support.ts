import { vi } from "vitest";
import { BankruptcyAction, BankruptcyTriggerKind, ProposalResolutionState, RuntimeMode, type EventLogEntry, type Proposal } from "@do-soul/alaya-protocol";
import type { TestMock } from "../shared/mock-types.js";

export type EventLogDraft = Omit<EventLogEntry, "event_id" | "created_at" | "revision">;

export type EventLogAppendMock = TestMock<(entry: EventLogDraft) => Promise<EventLogEntry>>;

export type EventLogQueryByEntityMock = TestMock<
  (entityType: string, entityId: string) => Promise<readonly EventLogEntry[]>
>;

export type BroadcastEntryMock = TestMock<(entry: EventLogEntry) => Promise<void>>;

export function createDeclareParams(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    workspaceId: "workspace-1",
    triggerKind: BankruptcyTriggerKind.TOKEN_OVERFLOW,
    triggerSummary: "Token estimate 1200 exceeds budget 800",
    taskSurfaceRef: "surface://task/main",
    taskSurfaceExpiresAt: "2026-03-26T01:00:00.000Z",
    currentMode: RuntimeMode.FULL,
    protectedConstraints: ["claim-1"],
    droppedCandidates: ["memory-1"],
    unresolvedConflicts: [],
    requiredActions: [BankruptcyAction.COMPRESS, BankruptcyAction.DEFER],
    ...overrides
  };
}

export function createDependencies(overrides: Partial<{
  eventLogRepo: ReturnType<typeof createEventLogRepo>;
  proposalPort: ReturnType<typeof createProposalPort>;
  runtimeNotifier: { notifyEntry: BroadcastEntryMock };
}> = {}) {
  const proposalPort = overrides.proposalPort ?? createProposalPort();
  return {
    eventLogRepo: overrides.eventLogRepo ?? createEventLogRepo(),
    proposalService: proposalPort,
    proposalPort,
    runtimeNotifier:
      overrides.runtimeNotifier ??
      {
        notifyEntry: vi.fn(async () => {})
      },
    generateRuntimeId: createRuntimeIdFactory(),
    now: () => "2026-03-26T00:00:00.000Z"
  };
}

export function createEventLogRepo(overrides: Partial<{
  append: EventLogAppendMock;
  queryByEntity: EventLogQueryByEntityMock;
}> = {}) {
  return {
    append:
      overrides.append ??
      vi.fn(async (entry: EventLogDraft) => createEventLogEntry(entry)),
    queryByEntity: overrides.queryByEntity ?? vi.fn(async () => [])
  };
}

export function createEventLogEntry(entry: EventLogDraft): EventLogEntry {
  return {
    event_id: `event-${entry.event_type}-${entry.entity_id}`,
    created_at: "2026-03-26T00:00:00.000Z",
    revision: 0,
    ...entry
  };
}

export function createProposalPort(overrides: Partial<{
  create: TestMock;
  update: TestMock;
  findById: TestMock;
  findPendingByRunId: TestMock;
}> = {}) {
  const proposals = new Map<string, Proposal>();

  const create =
    overrides.create ??
    vi.fn(async (params: {
      workspaceId: string;
      runId: string;
      dossierRef: string;
      options: Proposal["proposal_options"];
      recommendedOptionId: string | null;
      expiresAt: string | null;
    }) => {
      const proposal = createStoredProposal({
        runtime_id: "proposal-runtime-1",
        proposal_id: "proposal-runtime-1",
        dossier_ref: params.dossierRef,
        recommended_option_id: params.recommendedOptionId,
        proposal_options: params.options,
        resolution_state: "pending",
        expires_at: params.expiresAt,
        last_updated_at: "2026-03-26T00:00:00.000Z"
      });
      proposals.set(proposal.proposal_id, proposal);
      return proposal;
    });
  const update =
    overrides.update ??
    vi.fn(async (proposalId: string, patch: { resolution_state: Proposal["resolution_state"]; last_updated_at: string }) => {
      const existing = proposals.get(proposalId) ?? createStoredProposal({ proposal_id: proposalId, runtime_id: proposalId });
      const updated = {
        ...existing,
        resolution_state: patch.resolution_state,
        last_updated_at: patch.last_updated_at
      } satisfies Proposal;
      proposals.set(proposalId, updated);
      return updated;
    });
  const findById =
    overrides.findById ??
    vi.fn(async (proposalId: string) => proposals.get(proposalId) ?? null);
  const findPendingByRunId =
    overrides.findPendingByRunId ??
    vi.fn(async () => {
      for (const proposal of proposals.values()) {
        if (proposal.resolution_state === ProposalResolutionState.PENDING && proposal.dossier_ref !== null) {
          return proposal;
        }
      }

      return null;
    });

  return {
    create,
    update,
    findById,
    findPendingByRunId
  };
}

export function createStoredProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    runtime_id: "proposal-runtime-default",
    object_kind: "proposal",
    task_surface_ref: null,
    expires_at: null,
    derived_from: null,
    retention_policy: "session_only",
    proposal_id: "proposal-runtime-default",
    dossier_ref: "dossier-default",
    recommended_option_id: "option-trim_soft_context",
    proposal_options: [createProposalOption("trim_soft_context", false)],
    resolution_state: "pending",
    last_updated_at: "2026-03-26T00:00:00.000Z",
    ...overrides
  };
}

export function createProposalOption(
  optionKind: Proposal["proposal_options"][number]["option_kind"],
  requiresConfirmation: boolean
): Proposal["proposal_options"][number] {
  return {
    option_id: `option-${optionKind}`,
    option_kind: optionKind,
    preserves_protected_constraints: true,
    dropped_candidates: optionKind === "trim_soft_context" ? ["memory-1"] : [],
    unresolved_after_apply: [],
    requires_confirmation: requiresConfirmation
  };
}

export function createRuntimeIdFactory(): () => string {
  let index = 0;

  return () => {
    const value = index;
    index += 1;
    return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
  };
}

export function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve, reject };
}
