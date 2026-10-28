import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { initDatabase } from "../../../sqlite/db.js";
import { SqliteProposalRepo } from "../../../repos/proposal/index.js";
import * as acceptance from "../../../repos/proposal/mappers/acceptance.js";
import { createProposal, createRepo, createReviewEvents, countProposalEvents, trackedDatabases } from "./proposal-repo-fixture.js";

afterEach(() => {
  for (const database of trackedDatabases) database.close();
  trackedDatabases.clear();
});

const appliedStates = ["accepted", "auto_applied"] as const;
const genericEntries = ["unconditional", "pending", "with_events"] as const;
const appliedEntries = genericEntries.flatMap(entry => appliedStates.map(state => ({ entry, state })));

it.each(appliedStates)("refuses a new retired proposal already marked %s", async state => {
  for (const dossier of ["librarian.merge", "librarian.template", "librarian.compression", "inspector.strict_governance_promotion"]) {
    const { repo } = createRepo();
    const proposal = createProposal({ dossier_ref: dossier, resolution_state: state });
    await expect(repo.create({ proposal, workspace_id: "workspace-1", run_id: "run-1", target_object_kind: "memory_entry" }))
      .rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(repo.findById(proposal.proposal_id)).resolves.toBeNull();
  }
});

it.each([...appliedEntries, { entry: "privacy", state: "accepted" } as const])(
  "refuses retired $state through $entry while preserving rejection", async ({ entry, state }) => {
    for (const dossier of ["librarian.merge", "librarian.template", "librarian.compression", "inspector.strict_governance_promotion"]) {
      const { repo, database } = createRepo();
      const proposal = createProposal({ dossier_ref: dossier });
      await repo.create({ proposal, workspace_id: "workspace-1", run_id: "run-1",
        target_object_kind: entry === "privacy" ? "source_record" : "path_relation",
        ...(entry === "privacy" ? { proposal_operation: "privacy_erase", proposed_change_summary: "user_requested_deletion" } as const : {}) });
      const mutation = vi.fn(() => []);
      const timestamp = "2026-03-21T03:00:00.000Z";
      const accept = () => {
        if (entry === "unconditional") return repo.updateResolution(proposal.proposal_id, state, timestamp);
        if (entry === "pending") return repo.updatePendingResolution(proposal.proposal_id, state, timestamp);
        if (entry === "with_events") return repo.updatePendingResolutionWithEvents(proposal.proposal_id,
          state, timestamp, createReviewEvents(proposal));
        return repo.acceptPendingPrivacyEraseWithEvents(proposal.proposal_id, timestamp, createReviewEvents(proposal),
          { transactionScope: repo.transactionScope, apply: mutation });
      };
      await expect(accept()).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      await expect(repo.findById(proposal.proposal_id)).resolves.toMatchObject({ resolution_state: "pending" });
      await expect(repo.findPending("workspace-1")).resolves.toHaveLength(1);
      expect(countProposalEvents(database, proposal.proposal_id)).toBe(0);
      expect(mutation).not.toHaveBeenCalled();
      await expect(repo.updatePendingResolutionWithEvents(proposal.proposal_id, "rejected", timestamp, []))
        .resolves.toMatchObject({ proposal: { resolution_state: "rejected" } });
    }
  }
);

it.each(appliedEntries)(
  "refuses renamed null or strict path payloads through $entry->$state", async ({ entry, state }) => {
    for (const strict of [false, true]) {
      const { repo, database } = createRepo();
      const proposal = createProposal({ dossier_ref: "legacy.path_nomination" });
      await repo.create({ proposal, workspace_id: "workspace-1", run_id: "run-1", target_object_kind: "path_relation" });
      if (strict) {
        database.connection.prepare("UPDATE proposals SET proposed_path_relation=? WHERE proposal_id=?").run(JSON.stringify({
          target_anchor: { kind: "object", object_id: proposal.derived_from },
          constitution: { relation_kind: "constraint", why_this_relation_exists: ["historical decision"] },
          effect_vector: { salience: 1, recall_bias: 1, verification_bias: 1, unfinishedness_bias: 0,
            default_manifestation_preference: "stance_bias" },
          plasticity_state: { strength: 1, direction_bias: "source_to_target", stability_class: "pinned",
            support_events_count: 1, contradiction_events_count: 0 },
          lifecycle: { status: "active", retirement_rule: "manual" },
          legitimacy: { evidence_basis: ["historical-operator"], governance_class: "strictly_governed" }
        }), proposal.proposal_id);
      }
      const timestamp = "2026-03-21T03:00:00.000Z";
      const result = entry === "unconditional" ? repo.updateResolution(proposal.proposal_id, state, timestamp)
        : entry === "pending" ? repo.updatePendingResolution(proposal.proposal_id, state, timestamp)
        : repo.updatePendingResolutionWithEvents(proposal.proposal_id, state, timestamp, createReviewEvents(proposal));
      await expect(result).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      expect(countProposalEvents(database, proposal.proposal_id)).toBe(0);
      await expect(repo.findById(proposal.proposal_id)).resolves.toMatchObject({ resolution_state: "pending" });
      await expect(repo.updatePendingResolution(proposal.proposal_id, "rejected", timestamp))
        .resolves.toMatchObject({ resolution_state: "rejected" });
    }
  }
);

it.each(["unconditional", "pending"] as const)("locks the %s acceptance check against a second connection", async entry => {
  const directory = mkdtempSync(join(tmpdir(), "alaya-proposal-acceptance-"));
  const database = initDatabase({ filename: join(directory, "alaya.db") });
  const concurrent = new BetterSqlite3(database.filename);
  const repo = new SqliteProposalRepo(database);
  const proposal = createProposal();
  const verify = acceptance.assertProposalAcceptanceSupported;
  let blocked = false;
  try {
    await repo.create({ proposal, workspace_id: "workspace-1", run_id: "run-1", target_object_kind: "memory_entry" });
    concurrent.pragma("busy_timeout = 0");
    vi.spyOn(acceptance, "assertProposalAcceptanceSupported").mockImplementation(row => {
      expect(database.connection.inTransaction).toBe(true);
      try { concurrent.prepare("DELETE FROM proposals WHERE proposal_id=?").run(proposal.proposal_id); }
      catch (error) { blocked = error instanceof Error && /locked|busy/iu.test(error.message); }
      verify(row);
    });
    const timestamp = "2026-03-21T03:00:00.000Z";
    const result = entry === "unconditional" ? repo.updateResolution(proposal.proposal_id, "accepted", timestamp)
      : repo.updatePendingResolution(proposal.proposal_id, "accepted", timestamp);
    await expect(result).resolves.toMatchObject({ resolution_state: "accepted" });
    expect(blocked).toBe(true);
  } finally {
    vi.restoreAllMocks(); concurrent.close(); database.close(); rmSync(directory, { recursive: true, force: true });
  }
});
