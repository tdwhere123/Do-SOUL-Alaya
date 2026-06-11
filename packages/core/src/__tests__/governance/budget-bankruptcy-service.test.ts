import { describe, expect, it, vi } from "vitest";
import {
  BankruptcyAction,
  BankruptcyKind,
  BankruptcyTriggerKind,
  BudgetEventType,
  ProposalResolutionState,
  RuntimeMode,
  type EventLogEntry,
  type Proposal
} from "@do-soul/alaya-protocol";
import { BudgetBankruptcyService } from "../../governance/budget-bankruptcy-service.js";
import type { TestMock } from "../shared/mock-types.js";

type EventLogDraft = Omit<EventLogEntry, "event_id" | "created_at" | "revision">;
type EventLogAppendMock = TestMock<(entry: EventLogDraft) => Promise<EventLogEntry>>;
type EventLogQueryByEntityMock = TestMock<
  (entityType: string, entityId: string) => Promise<readonly EventLogEntry[]>
>;
type BroadcastEntryMock = TestMock<(entry: EventLogEntry) => Promise<void>>;

describe("BudgetBankruptcyService", () => {
  it("declares a soft bankruptcy, persists the proposal, updates current mode, and broadcasts both budget events", async () => {
    const dependencies = createDependencies();
    const service = new BudgetBankruptcyService(dependencies);

    const result = await service.declare(createDeclareParams());

    expect(result.state.bankruptcy_kind).toBe(BankruptcyKind.SOFT);
    expect(result.state.current_mode).toBe(RuntimeMode.LEAN);
    expect(result.proposal.resolution_state).toBe(ProposalResolutionState.AUTO_APPLIED);
    expect(dependencies.proposalPort.create).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        dossierRef: result.dossier.runtime_id
      })
    );
    expect(dependencies.proposalPort.update).toHaveBeenCalledWith(
      result.proposal.proposal_id,
      expect.objectContaining({
        resolution_state: ProposalResolutionState.AUTO_APPLIED
      })
    );
    expect(dependencies.runtimeNotifier.notifyEntry.mock.calls.map(([entry]) => entry.event_type)).toEqual([
      BudgetEventType.SOUL_BUDGET_BANKRUPTCY_DECLARED,
      BudgetEventType.SOUL_BUDGET_BANKRUPTCY_RESOLVED
    ]);
  });

  it("keeps hard bankruptcies pending when no auto-applicable option exists", async () => {
    const dependencies = createDependencies();
    const service = new BudgetBankruptcyService(dependencies);

    const result = await service.declare(
      createDeclareParams({
        triggerKind: BankruptcyTriggerKind.SAFETY_GUARD,
        requiredActions: [BankruptcyAction.STOP]
      })
    );

    expect(result.state.bankruptcy_kind).toBe(BankruptcyKind.HARD);
    expect(result.proposal.resolution_state).toBe(ProposalResolutionState.PENDING);
    expect(dependencies.proposalPort.update).not.toHaveBeenCalled();
    expect(
      dependencies.runtimeNotifier.notifyEntry.mock.calls.filter(
        ([entry]) => entry.event_type === BudgetEventType.SOUL_BUDGET_BANKRUPTCY_RESOLVED
      )
    ).toHaveLength(0);
  });

  it("rejects a second pending bankruptcy for the same run", async () => {
    const dependencies = createDependencies({
      proposalPort: createProposalPort({
        findPendingByRunId: vi.fn(async () =>
          createStoredProposal({ resolution_state: "pending", dossier_ref: "dossier-1" })
        )
      })
    });
    const service = new BudgetBankruptcyService(dependencies);

    await expect(service.declare(createDeclareParams())).rejects.toMatchObject({
      code: "CONFLICT"
    });
  });

  it("coalesces concurrent declarations for the same run into a single proposal write", async () => {
    const createGate = createDeferred<Proposal>();
    const dependencies = createDependencies({
      proposalPort: createProposalPort({
        create: vi.fn(async (params) => {
          await createGate.promise;
          return createStoredProposal({
            runtime_id: "proposal-race",
            proposal_id: "proposal-race",
            dossier_ref: params.dossierRef,
            recommended_option_id: params.recommendedOptionId,
            proposal_options: params.options,
            resolution_state: "pending",
            expires_at: params.expiresAt,
            last_updated_at: "2026-03-26T00:00:00.000Z"
          });
        })
      })
    });
    const service = new BudgetBankruptcyService(dependencies);
    const declareParams = createDeclareParams({
      triggerKind: BankruptcyTriggerKind.SAFETY_GUARD,
      requiredActions: [BankruptcyAction.STOP]
    });

    const first = service.declare(declareParams);
    const second = service.declare(declareParams);
    createGate.resolve(createStoredProposal({
      runtime_id: "proposal-race",
      proposal_id: "proposal-race",
      dossier_ref: "00000000-0000-4000-8000-000000000001",
      proposal_options: [
        createProposalOption("request_confirmation", true),
        createProposalOption("abort_high_risk_write", true)
      ],
      recommended_option_id: "option-request_confirmation"
    }));

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(dependencies.proposalPort.create).toHaveBeenCalledTimes(1);
    expect(
      dependencies.eventLogRepo.append.mock.calls.filter(
        ([entry]) => entry.event_type === BudgetEventType.SOUL_BUDGET_BANKRUPTCY_DECLARED
      )
    ).toHaveLength(1);
    expect(firstResult.proposal.proposal_id).toBe("proposal-race");
    expect(secondResult.proposal.proposal_id).toBe("proposal-race");
  });

  it("resolves a pending bankruptcy with an accepted option and keeps the chosen mode sticky in snapshots", async () => {
    const dependencies = createDependencies();
    const service = new BudgetBankruptcyService(dependencies);
    const declared = await service.declare(
      createDeclareParams({
        triggerKind: BankruptcyTriggerKind.SAFETY_GUARD,
        requiredActions: [BankruptcyAction.STOP]
      })
    );
    const confirmationOption = declared.proposal.proposal_options.find((option) => option.requires_confirmation);

    expect(confirmationOption).toBeDefined();

    const updated = await service.resolve({
      runId: "run-1",
      workspaceId: "workspace-1",
      optionId: confirmationOption!.option_id,
      action: "accept"
    });

    expect(updated.resolution_state).toBe(ProposalResolutionState.ACCEPTED);

    const snapshot = await service.getSnapshot("run-1", "2026-03-26T00:10:00.000Z");
    expect(snapshot.current_mode).toBe(RuntimeMode.MINIMAL);
    expect(snapshot.pending_proposal?.resolution_state).toBe(ProposalResolutionState.ACCEPTED);
  });

  it("rejects option ids that are not present on the active pending proposal", async () => {
    const dependencies = createDependencies();
    const service = new BudgetBankruptcyService(dependencies);
    await service.declare(
      createDeclareParams({
        triggerKind: BankruptcyTriggerKind.SAFETY_GUARD,
        requiredActions: [BankruptcyAction.STOP]
      })
    );

    await expect(
      service.resolve({
        runId: "run-1",
        workspaceId: "workspace-1",
        optionId: "missing-option",
        action: "accept"
      })
    ).rejects.toMatchObject({
      code: "VALIDATION"
    });
  });

  it("recovers pending hard bankruptcies after restart by replaying the declared dossier event", async () => {
    const pendingProposal = createStoredProposal({
      proposal_id: "proposal-recovered",
      runtime_id: "proposal-recovered",
      dossier_ref: "00000000-0000-4000-8000-000000000998",
      proposal_options: [
        createProposalOption("request_confirmation", true),
        createProposalOption("abort_high_risk_write", true)
      ]
    });
    const dependencies = createDependencies({
      proposalPort: createProposalPort({
        findPendingByRunId: vi.fn(async () => pendingProposal),
        findById: vi.fn(async (proposalId: string) =>
          proposalId === pendingProposal.proposal_id ? pendingProposal : null
        ),
        update: vi.fn(async (proposalId, patch) => ({
          ...pendingProposal,
          proposal_id: proposalId,
          resolution_state: patch.resolution_state,
          last_updated_at: patch.last_updated_at
        }))
      }),
      eventLogRepo: createEventLogRepo({
        queryByEntity: vi.fn(async (entityType: string, entityId: string) =>
          entityType === "bankruptcy_dossier" && entityId === "00000000-0000-4000-8000-000000000998"
            ? [
                createEventLogEntry({
                  event_type: BudgetEventType.SOUL_BUDGET_BANKRUPTCY_DECLARED,
                  entity_type: "bankruptcy_dossier",
                  entity_id: "00000000-0000-4000-8000-000000000998",
                  workspace_id: "workspace-1",
                  run_id: "run-1",
                  caused_by: "system",
                  payload_json: {
                    bankruptcy_id: "00000000-0000-4000-8000-000000000999",
                    bankruptcy_kind: "hard",
                    trigger_kind: "strict_conflict",
                    current_mode: "lean",
                    trigger_summary: "Strict conflict remains unresolved",
                    mode_at_trigger: "lean",
                    task_surface_ref: "surface://task/main",
                    protected_constraints_preserved: ["claim-1"],
                    dropped_candidates: ["memory-1"],
                    unresolved_conflicts: ["conflict-1"],
                    required_actions: ["compress", "arbitrate"],
                    expires_at: "2026-03-26T01:00:00.000Z",
                    run_id: "run-1",
                    workspace_id: "workspace-1",
                    occurred_at: "2026-03-26T00:00:00.000Z"
                  }
                })
              ]
            : []
        )
      })
    });
    const service = new BudgetBankruptcyService(dependencies);

    const updated = await service.resolve({
      runId: "run-1",
      workspaceId: "workspace-1",
      optionId: pendingProposal.proposal_options[0]!.option_id,
      action: "accept"
    });

    expect(updated.resolution_state).toBe(ProposalResolutionState.ACCEPTED);
    expect(dependencies.eventLogRepo.queryByEntity).toHaveBeenCalledWith(
      "bankruptcy_dossier",
      "00000000-0000-4000-8000-000000000998"
    );
  });

  it("recovers the active snapshot after restart before any resolve call happens", async () => {
    const pendingProposal = createStoredProposal({
      proposal_id: "proposal-recovered",
      runtime_id: "proposal-recovered",
      dossier_ref: "00000000-0000-4000-8000-000000000998",
      proposal_options: [
        createProposalOption("request_confirmation", true),
        createProposalOption("abort_high_risk_write", true)
      ]
    });
    const dependencies = createDependencies({
      proposalPort: createProposalPort({
        findPendingByRunId: vi.fn(async () => pendingProposal),
        findById: vi.fn(async (proposalId: string) =>
          proposalId === pendingProposal.proposal_id ? pendingProposal : null
        )
      }),
      eventLogRepo: createEventLogRepo({
        queryByEntity: vi.fn(async (entityType: string, entityId: string) =>
          entityType === "bankruptcy_dossier" && entityId === "00000000-0000-4000-8000-000000000998"
            ? [
                createEventLogEntry({
                  event_type: BudgetEventType.SOUL_BUDGET_BANKRUPTCY_DECLARED,
                  entity_type: "bankruptcy_dossier",
                  entity_id: "00000000-0000-4000-8000-000000000998",
                  workspace_id: "workspace-1",
                  run_id: "run-1",
                  caused_by: "system",
                  payload_json: {
                    bankruptcy_id: "00000000-0000-4000-8000-000000000999",
                    bankruptcy_kind: "hard",
                    trigger_kind: "strict_conflict",
                    current_mode: "lean",
                    trigger_summary: "Strict conflict remains unresolved",
                    mode_at_trigger: "full",
                    task_surface_ref: "surface://task/main",
                    protected_constraints_preserved: ["claim-1"],
                    dropped_candidates: ["memory-1"],
                    unresolved_conflicts: ["conflict-1"],
                    required_actions: ["compress", "arbitrate"],
                    expires_at: "2026-03-26T01:00:00.000Z",
                    run_id: "run-1",
                    workspace_id: "workspace-1",
                    occurred_at: "2026-03-26T00:00:00.000Z"
                  }
                })
              ]
            : []
        )
      })
    });
    const service = new BudgetBankruptcyService(dependencies);

    const snapshot = await service.getSnapshot("run-1", "2026-03-26T00:10:00.000Z");

    expect(snapshot).toMatchObject({
      run_id: "run-1",
      current_mode: RuntimeMode.LEAN,
      bankruptcy_kind: BankruptcyKind.HARD,
      active_dossier: expect.objectContaining({
        mode_at_trigger: RuntimeMode.FULL,
        required_actions: ["compress", "arbitrate"]
      }),
      pending_proposal: expect.objectContaining({
        proposal_id: "proposal-recovered",
        resolution_state: ProposalResolutionState.PENDING
      })
    });
    expect(dependencies.eventLogRepo.queryByEntity).toHaveBeenCalledWith(
      "bankruptcy_dossier",
      "00000000-0000-4000-8000-000000000998"
    );
  });

  it("rejects required actions that are not already valid bankruptcy action values", async () => {
    const dependencies = createDependencies();
    const service = new BudgetBankruptcyService(dependencies);

    await expect(
      service.declare(
        createDeclareParams({
          requiredActions: [BankruptcyAction.COMPRESS, "DeFeR" as BankruptcyAction]
        })
      )
    ).rejects.toMatchObject({
      code: "VALIDATION"
    });
  });

  it("returns the default snapshot when no bankruptcy is active and clears run state on teardown", async () => {
    const dependencies = createDependencies();
    const service = new BudgetBankruptcyService(dependencies);

    expect(await service.getSnapshot("run-404", "2026-03-26T00:00:00.000Z")).toMatchObject({
      run_id: "run-404",
      current_mode: RuntimeMode.FULL,
      bankruptcy_kind: BankruptcyKind.NONE,
      active_dossier: null,
      pending_proposal: null
    });

    await service.declare(createDeclareParams());
    service.clearRun("run-1");

    expect(await service.getSnapshot("run-1", "2026-03-26T00:00:00.000Z")).toMatchObject({
      run_id: "run-1",
      current_mode: RuntimeMode.FULL,
      bankruptcy_kind: BankruptcyKind.NONE,
      active_dossier: null,
      pending_proposal: null
    });
  });
});

function createDeclareParams(overrides: Record<string, unknown> = {}) {
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

function createDependencies(overrides: Partial<{
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

function createEventLogRepo(overrides: Partial<{
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

function createEventLogEntry(entry: EventLogDraft): EventLogEntry {
  return {
    event_id: `event-${entry.event_type}-${entry.entity_id}`,
    created_at: "2026-03-26T00:00:00.000Z",
    revision: 0,
    ...entry
  };
}

function createProposalPort(overrides: Partial<{
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

function createStoredProposal(overrides: Partial<Proposal> = {}): Proposal {
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

function createProposalOption(
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

function createRuntimeIdFactory(): () => string {
  let index = 0;

  return () => {
    const value = index;
    index += 1;
    return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve, reject };
}
