import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BudgetBankruptcyService } from "@do-soul/alaya-core";
import {
  BankruptcyAction, BankruptcyTriggerKind, BudgetEventType, RuntimeMode, type EventLogEntry
} from "@do-soul/alaya-protocol";
import { initDatabase, SqliteEventLogRepo, SqliteProposalRepo } from "@do-soul/alaya-storage";
import { describe, expect, it, vi } from "vitest";
import { createBudgetProposalPort } from "../../budget/wiring.js";

const now = () => "2026-03-26T00:00:00.000Z";
const input = {
  runId: "run-1", workspaceId: "workspace-1", triggerKind: BankruptcyTriggerKind.SAFETY_GUARD,
  triggerSummary: "Protected constraint requires confirmation", taskSurfaceRef: null, taskSurfaceExpiresAt: null,
  currentMode: RuntimeMode.FULL, protectedConstraints: ["claim-1"], droppedCandidates: [],
  unresolvedConflicts: [], requiredActions: [BankruptcyAction.STOP]
};

function openBudget(filename = ":memory:", notifyEntry: (entry: EventLogEntry) => void | Promise<void> = vi.fn()) {
  const database = initDatabase({ filename });
  const eventLogRepo = new SqliteEventLogRepo(database);
  const proposalRepo = new SqliteProposalRepo(database);
  const service = new BudgetBankruptcyService({ eventLogRepo,
    proposalService: createBudgetProposalPort({ proposalRepo, now }), runtimeNotifier: { notifyEntry }, now });
  return { database, eventLogRepo, proposalRepo, service };
}

const resolvedType = BudgetEventType.SOUL_BUDGET_BANKRUPTCY_RESOLVED;

describe("bankruptcy resolution durability", () => {
  it.each(["accepted", "rejected", "auto_applied"] as const)(
    "keeps %s committed before notification and restores its mode after reopening SQLite",
    async (resolution) => {
      const directory = mkdtempSync(join(tmpdir(), "alaya-bankruptcy-"));
      const filename = join(directory, "state.sqlite");
      let observedResolution: string | undefined;
      const notifyEntry = vi.fn(async (entry: EventLogEntry) => {
        if (entry.event_type !== resolvedType) return;
        const proposalId = entry.payload_json["proposal_id"] as string;
        observedResolution = (await fixture.proposalRepo.findById(proposalId))?.resolution_state;
        throw new Error("injected listener failure");
      });
      let fixture = openBudget(filename, notifyEntry);
      try {
        const declared = await fixture.service.declare(resolution === "auto_applied" ? {
          ...input, triggerKind: BankruptcyTriggerKind.TOKEN_OVERFLOW,
          droppedCandidates: ["memory-1"], requiredActions: [BankruptcyAction.COMPRESS]
        } : input);
        const optionId = declared.proposal.proposal_options[0]!.option_id;
        const proposal = resolution === "auto_applied" ? declared.proposal : await fixture.service.resolve({
          runId: input.runId, workspaceId: input.workspaceId, optionId,
          action: resolution === "accepted" ? "accept" : "reject"
        });
        expect(proposal.resolution_state).toBe(resolution);
        expect(observedResolution).toBe(resolution);
        expect(notifyEntry.mock.calls.filter(([entry]) => entry.event_type === resolvedType)).toHaveLength(1);
        fixture.database.close();
        fixture = openBudget(filename);
        const expectedMode = resolution === "accepted" ? RuntimeMode.MINIMAL
          : resolution === "auto_applied" ? RuntimeMode.LEAN : RuntimeMode.FULL;
        expect(await fixture.service.getSnapshot(input.runId, now())).toMatchObject({
          current_mode: expectedMode, pending_proposal: { resolution_state: resolution }
        });
        await expect(fixture.service.resolve({
          runId: input.runId, workspaceId: input.workspaceId, optionId, action: "accept"
        })).rejects.toMatchObject({ code: "VALIDATION" });
        expect(await fixture.eventLogRepo.queryByRunAndEventType(input.runId, resolvedType)).toHaveLength(1);
        const next = await fixture.service.declare(input);
        expect(next.state.current_mode).toBe(expectedMode);
      } finally {
        fixture.database.close();
        rmSync(directory, { recursive: true, force: true });
      }
    }
  );

  it.each(["event_log", "proposals"])("rolls back a failed %s resolution write and permits one concurrent retry", async (table) => {
    const notifyEntry = vi.fn();
    const fixture = openBudget(":memory:", notifyEntry);
    try {
      const declared = await fixture.service.declare(input);
      const resolution = { runId: input.runId, workspaceId: input.workspaceId,
        optionId: declared.proposal.proposal_options[0]!.option_id, action: "accept" as const };
      fixture.database.connection.exec(table === "event_log"
        ? `CREATE TRIGGER reject_resolution BEFORE INSERT ON event_log WHEN NEW.event_type = '${resolvedType}'
           BEGIN SELECT RAISE(ABORT, 'injected resolution failure'); END`
        : `CREATE TRIGGER reject_resolution BEFORE UPDATE ON proposals
           BEGIN SELECT RAISE(ABORT, 'injected resolution failure'); END`);
      await expect(fixture.service.resolve(resolution)).rejects.toThrow();
      expect(await fixture.proposalRepo.findById(declared.proposal.proposal_id)).toMatchObject({ resolution_state: "pending" });
      expect(await fixture.eventLogRepo.queryByRunAndEventType(input.runId, resolvedType)).toEqual([]);
      expect(notifyEntry.mock.calls.filter(([entry]) => entry.event_type === resolvedType)).toEqual([]);
      fixture.database.connection.exec("DROP TRIGGER reject_resolution");
      const attempts = await Promise.allSettled([fixture.service.resolve(resolution), fixture.service.resolve(resolution)]);
      expect(attempts.map(attempt => attempt.status).sort()).toEqual(["fulfilled", "rejected"]);
      expect(await fixture.proposalRepo.findById(declared.proposal.proposal_id)).toMatchObject({ resolution_state: "accepted" });
      expect(await fixture.eventLogRepo.queryByRunAndEventType(input.runId, resolvedType)).toHaveLength(1);
    } finally { fixture.database.close(); }
  });

  it.each(["accepted", "rejected"] as const)(
    "repairs an old committed %s history without resurrecting pending or appending another resolution",
    async (resolution) => {
      const directory = mkdtempSync(join(tmpdir(), "alaya-bankruptcy-recovery-"));
      const filename = join(directory, "state.sqlite");
      const notifyEntry = vi.fn();
      let fixture = openBudget(filename, notifyEntry);
      try {
        const declared = await fixture.service.declare(input);
        const optionId = declared.proposal.proposal_options[0]!.option_id;
        await fixture.eventLogRepo.append({
          event_type: resolvedType, entity_type: "bankruptcy_dossier", entity_id: declared.dossier.runtime_id,
          workspace_id: input.workspaceId, run_id: input.runId, caused_by: "user",
          payload_json: {
            bankruptcy_id: declared.state.bankruptcy_id, proposal_id: declared.proposal.proposal_id,
            resolution_state: resolution, option_id_applied: resolution === "accepted" ? optionId : null,
            run_id: input.runId, workspace_id: input.workspaceId, occurred_at: now()
          }
        });
        fixture.database.connection.exec(`CREATE TRIGGER reject_recovery BEFORE UPDATE ON proposals
          BEGIN SELECT RAISE(ABORT, 'injected recovery failure'); END`);
        // The cached declaration must not hide a committed decision or cache a failed repair as absence.
        await expect(fixture.service.getSnapshot(input.runId, now())).rejects.toThrow();
        expect(await fixture.eventLogRepo.queryByRunAndEventType(input.runId, resolvedType)).toHaveLength(1);
        fixture.database.connection.exec("DROP TRIGGER reject_recovery");
        fixture.database.close();
        fixture = openBudget(filename, notifyEntry);
        const snapshots = await Promise.all([
          fixture.service.getSnapshot(input.runId, now()), fixture.service.getSnapshot(input.runId, now())
        ]);
        for (const snapshot of snapshots) expect(snapshot).toMatchObject({
          current_mode: resolution === "accepted" ? RuntimeMode.MINIMAL : RuntimeMode.FULL,
          pending_proposal: { resolution_state: resolution }
        });
        expect(await fixture.proposalRepo.findPendingByRunId(input.runId)).toBeNull();
        await expect(fixture.service.resolve({
          runId: input.runId, workspaceId: input.workspaceId, optionId, action: "accept"
        })).rejects.toMatchObject({ code: "VALIDATION" });
        expect(await fixture.eventLogRepo.queryByRunAndEventType(input.runId, resolvedType)).toHaveLength(1);
        expect(notifyEntry.mock.calls.filter(([entry]) => entry.event_type === resolvedType)).toEqual([]);
      } finally {
        fixture.database.close();
        rmSync(directory, { recursive: true, force: true });
      }
    }
  );
});
