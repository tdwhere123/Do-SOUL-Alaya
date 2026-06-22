import { describe, expect, it, vi } from "vitest";
import { BankruptcyAction, BankruptcyKind, BankruptcyTriggerKind, BudgetEventType, ProposalResolutionState, RuntimeMode, type Proposal } from "@do-soul/alaya-protocol";
import { BudgetBankruptcyService } from "../../governance/budget-bankruptcy-service.js";

import { createDeclareParams, createDeferred, createDependencies, createEventLogEntry, createEventLogRepo, createProposalOption, createProposalPort, createStoredProposal } from "./budget-bankruptcy-service.test-support.js";

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

  it("bounds process-local stateStore entries by least-recently-used run", async () => {
    const dependencies = createDependencies();
    const service = new BudgetBankruptcyService({
      ...dependencies,
      stateStoreMaxEntries: 2
    });

    await service.declare(createDeclareParams({ runId: "run-1" }));
    await service.declare(createDeclareParams({ runId: "run-2" }));
    await service.getSnapshot("run-1", "2026-03-26T00:00:00.000Z");
    await service.declare(createDeclareParams({ runId: "run-3" }));

    const stateStore = (service as unknown as { readonly stateStore: Map<string, unknown> }).stateStore;
    expect([...stateStore.keys()]).toEqual(["run-1", "run-3"]);
  });

  it("expires stale process-local stateStore entries instead of retaining every run forever", async () => {
    let now = "2026-03-26T00:00:00.000Z";
    const dependencies = createDependencies();
    const service = new BudgetBankruptcyService({
      ...dependencies,
      now: () => now,
      stateStoreTtlMs: 1
    });
    await service.declare(createDeclareParams({ runId: "run-stale" }));

    now = "2026-03-26T00:00:00.002Z";
    const snapshot = await service.getSnapshot("run-stale", now);

    expect(snapshot.bankruptcy_kind).toBe(BankruptcyKind.NONE);
    expect(
      (service as unknown as { readonly stateStore: Map<string, unknown> }).stateStore.has(
        "run-stale"
      )
    ).toBe(false);
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
