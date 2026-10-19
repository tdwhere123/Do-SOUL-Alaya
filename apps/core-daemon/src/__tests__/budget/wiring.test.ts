import { BankruptcyAction, BankruptcyTriggerKind, BudgetEventType, ProposalResolutionState, RuntimeMode, type Proposal } from "@do-soul/alaya-protocol";
import { BudgetBankruptcyService } from "@do-soul/alaya-core";
import { initDatabase, SqliteEventLogRepo, SqliteProposalRepo } from "@do-soul/alaya-storage";
import { describe, expect, it, vi } from "vitest";
import { createBudgetProposalPort } from "../../budget/wiring.js";

describe("budget wiring", () => {
  it.each(["event_log", "proposals"])("rolls back declaration and proposal when %s insert fails, then retries successfully", async (table) => {
    const database = initDatabase({ filename: ":memory:" });
    try {
      const eventLogRepo = new SqliteEventLogRepo(database);
      const proposalRepo = new SqliteProposalRepo(database);
      const notifyEntry = vi.fn();
      const now = () => "2026-03-26T00:00:00.000Z";
      const service = new BudgetBankruptcyService({ eventLogRepo,
        proposalService: createBudgetProposalPort({ proposalRepo, now }), runtimeNotifier: { notifyEntry }, now });
      const input = { runId: "run-1", workspaceId: "workspace-1", triggerKind: BankruptcyTriggerKind.SAFETY_GUARD,
        triggerSummary: "Protected constraint requires confirmation", taskSurfaceRef: null, taskSurfaceExpiresAt: null,
        currentMode: RuntimeMode.FULL, protectedConstraints: ["claim-1"], droppedCandidates: [],
        unresolvedConflicts: [], requiredActions: [BankruptcyAction.DEFER] };
      database.connection.exec(`CREATE TRIGGER reject_budget_insert BEFORE INSERT ON ${table}
        BEGIN SELECT RAISE(ABORT, 'injected budget persistence failure'); END`);
      await expect(service.declare(input)).rejects.toThrow();
      expect(database.connection.prepare("SELECT * FROM proposals").all()).toEqual([]);
      expect(database.connection.prepare("SELECT * FROM event_log").all()).toEqual([]);
      expect(notifyEntry).not.toHaveBeenCalled();
      database.connection.exec("DROP TRIGGER reject_budget_insert");
      const result = await service.declare(input);
      expect(await proposalRepo.findById(result.proposal.proposal_id)).toMatchObject({ resolution_state: "pending" });
      const events = (await eventLogRepo.queryByType(BudgetEventType.SOUL_BUDGET_BANKRUPTCY_DECLARED)).events;
      expect(events).toHaveLength(1);
      expect(notifyEntry).toHaveBeenCalledTimes(1);
      expect(notifyEntry).toHaveBeenCalledWith(events[0]);
    } finally { database.close(); }
  });
  it("creates and resolves bankruptcy proposals through the proposal port contract", async () => {
    const proposals = new Map<string, Proposal>();
    const createdRows: Array<{
      workspace_id: string;
      run_id: string;
      target_object_kind: string;
      proposed_change_summary: string;
    }> = [];
    const proposalRepo = {
      createProposalWithEvents: async (input: {
        proposal: Proposal;
        workspace_id: string;
        run_id: string;
        target_object_kind: string;
        proposed_change_summary: string;
      }) => {
        proposals.set(input.proposal.proposal_id, input.proposal);
        createdRows.push({
          workspace_id: input.workspace_id,
          run_id: input.run_id,
          target_object_kind: input.target_object_kind,
          proposed_change_summary: input.proposed_change_summary
        });
        return { proposal: input.proposal, events: [] };
      },
      updatePendingResolution: async (
        proposalId: string,
        resolutionState: Proposal["resolution_state"],
        lastUpdatedAt: string
      ) => {
        const existing = proposals.get(proposalId);
        if (existing === undefined) {
          throw new Error(`missing proposal ${proposalId}`);
        }
        proposals.set(proposalId, {
          ...existing,
          resolution_state: resolutionState,
          last_updated_at: lastUpdatedAt
        });
      },
      findById: async (proposalId: string) => proposals.get(proposalId) ?? null,
      findPendingByRunId: async (runId: string) =>
        createdRows
          .filter((row) => row.run_id === runId)
          .map((row) =>
            Array.from(proposals.values()).find(
              (proposal) =>
                proposal.resolution_state === ProposalResolutionState.PENDING &&
                row.proposed_change_summary === `Bankruptcy resolution: ${proposal.dossier_ref}`
            )
          )
          .find((proposal): proposal is Proposal => proposal !== undefined) ?? null
    };
    const now = () => "2026-03-26T00:00:00.000Z";
    const port = createBudgetProposalPort({
      proposalRepo: proposalRepo as never,
      now,
      generateProposalId: () => "00000000-0000-4000-8000-000000000123"
    });

    const { proposal: created } = await port.createWithEvents({
      workspaceId: "workspace-1",
      runId: "run-1",
      dossierRef: "dossier-1",
      options: [
        {
          option_id: "option-request_confirmation",
          option_kind: "request_confirmation",
          preserves_protected_constraints: true,
          dropped_candidates: [],
          unresolved_after_apply: [],
          requires_confirmation: true
        }
      ],
      recommendedOptionId: null,
      expiresAt: null
    }, []);

    expect(created).toMatchObject({
      proposal_id: "00000000-0000-4000-8000-000000000123",
      dossier_ref: "dossier-1",
      resolution_state: ProposalResolutionState.PENDING,
      last_updated_at: now()
    });
    expect(createdRows).toEqual([
      {
        workspace_id: "workspace-1",
        run_id: "run-1",
        target_object_kind: "bankruptcy_dossier",
        proposed_change_summary: "Bankruptcy resolution: dossier-1"
      }
    ]);
    await expect(port.findPendingByRunId("run-1")).resolves.toMatchObject({
      proposal_id: "00000000-0000-4000-8000-000000000123",
      resolution_state: ProposalResolutionState.PENDING
    });

    await port.update(created.proposal_id, {
      resolution_state: ProposalResolutionState.REJECTED,
      last_updated_at: "2026-03-26T00:05:00.000Z"
    });

    await expect(port.findById(created.proposal_id)).resolves.toMatchObject({
      resolution_state: ProposalResolutionState.REJECTED,
      last_updated_at: "2026-03-26T00:05:00.000Z"
    });
    await expect(port.findPendingByRunId("run-1")).resolves.toBeNull();
  });
});
