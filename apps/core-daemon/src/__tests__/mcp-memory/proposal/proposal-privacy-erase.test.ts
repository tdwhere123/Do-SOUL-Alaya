import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FieldGenerationEventType,
  ProposalResolutionState,
  WorkspaceKind,
  WorkspaceState,
  hashLabeledIdentity,
  type EffectDecisionReceipt
} from "@do-soul/alaya-protocol";
import {
  initDatabase,
  SqliteEventLogRepo,
  SqliteFieldEraseBarrierRepo,
  SqliteFieldProofEffectRepo,
  SqliteProposalRepo,
  SqliteWorkspaceRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import { createMcpMemoryProposalWorkflow } from "../../../mcp-memory/proposal/proposal-workflow.js";
import { createPrivacyEffectLookup } from "../../../mcp-memory/proposal/phases/privacy-hard-effect.js";

const WORKSPACE_ID = "workspace-privacy-erase";
const RECORD_ID = "source-record-private";
const PROPOSAL_ID = "11111111-1111-4111-8111-111111111111";
const BARRIER_ID = "22222222-2222-4222-8222-222222222222";
const TIMESTAMP = "2026-08-17T00:00:00.000Z";
const SENSITIVE_MARKER = "PRIVATE_DELETE_CONTEXT_7f4d";
const RUN_ID = "run-privacy-erase";
const databases = new Set<StorageDatabase>();
const tempDirectories = new Set<string>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
  for (const directory of tempDirectories) rmSync(directory, { recursive: true, force: true });
  tempDirectories.clear();
});

describe("privacy erase proposal review", () => {
  it("applies the source closure only when the review accepts", async () => {
    const harness = createHarness();
    const created = await proposePrivacyErase(harness.workflow);

    await expect(harness.proposalRepo.findScopedById(created.proposal_id)).resolves.toMatchObject({
      proposal_operation: "privacy_erase",
      target_object_kind: "source_record",
      proposed_changes: null
    });
    await expect(harness.proposalRepo.findPendingSummaries(WORKSPACE_ID)).resolves.toMatchObject([
      { proposal_operation: "privacy_erase", target_object_kind: "source_record" }
    ]);
    await expect(acceptPrivacyErase(harness.workflow, created.proposal_id)).resolves.toEqual({
      proposal_id: created.proposal_id,
      resolution_state: ProposalResolutionState.ACCEPTED
    });

    expect(readSourceBody(harness.database)).toBeNull();
    expect(harness.eraseRepo.findById(WORKSPACE_ID, BARRIER_ID)).toMatchObject({
      identity: eraseReceiptIdentity(),
      subject_kind: "source_record",
      subject_id: RECORD_ID
    });
    const events = await harness.eventLogRepo.queryByEntity(
      "projection_erase_barrier",
      eraseReceiptIdentity()
    );
    expect(events.map((event) => event.event_type)).toContain(
      FieldGenerationEventType.SOUL_FIELD_ERASE_BARRIER
    );
    expect(events[0]).toMatchObject({
      entity_type: "projection_erase_barrier",
      entity_id: eraseReceiptIdentity(),
      payload_json: { receipt_identity: eraseReceiptIdentity() }
    });
    expect(readEffectDecision(harness.database)).toMatchObject({
      action: "erase",
      target: RECORD_ID,
      decision: "allow",
      witness_kinds: ["actor_authority", "confirmation"]
    });
    expect(countEventType(
      harness.database,
      FieldGenerationEventType.SOUL_FIELD_EFFECT_DECIDED
    )).toBe(1);
    expect(readPrivacyAuditText(harness.database)).not.toContain(SENSITIVE_MARKER);
  });

  it("denies accept when the hard-effect lookup reports a revoked bridge", async () => {
    const harness = createHarness();
    const created = await proposePrivacyErase(harness.workflow);
    const workflow = createWorkflow(
      harness.proposalRepo,
      harness.eventLogRepo,
      harness.eraseRepo,
      {
        ...harness.effectPort,
        lookup: {
          ...harness.effectPort.lookup,
          isBridgeRevoked: () => true
        }
      }
    );

    await expect(acceptPrivacyErase(workflow, created.proposal_id)).rejects.toThrow(
      /Failed to accept privacy erase proposal/u
    );
    expect(readSourceBody(harness.database)).toBe(SENSITIVE_MARKER);
    expect(harness.eraseRepo.findById(WORKSPACE_ID, BARRIER_ID)).toBeNull();
    await expect(harness.proposalRepo.findScopedById(created.proposal_id)).resolves.toMatchObject({
      proposal: { resolution_state: ProposalResolutionState.PENDING }
    });
  });

  it("keeps plaintext and creates no barrier when the review rejects", async () => {
    const harness = createHarness();
    const created = await proposePrivacyErase(harness.workflow);

    await harness.workflow.reviewMemoryProposal(
      reviewRequest(created.proposal_id, "reject"),
      reviewContext()
    );

    expect(readSourceBody(harness.database)).toBe(SENSITIVE_MARKER);
    expect(harness.eraseRepo.findById(WORKSPACE_ID, BARRIER_ID)).toBeNull();
    expect(countRows(harness.database, "proof_effect_decisions")).toBe(0);
    expect(readPrivacyAuditText(harness.database)).not.toContain(SENSITIVE_MARKER);
    await expect(harness.proposalRepo.findScopedById(created.proposal_id)).resolves.toMatchObject({
      proposal: { resolution_state: ProposalResolutionState.REJECTED }
    });
  });

  it("rolls back the erase, review events, and accepted state when the mutation fails", async () => {
    const harness = createHarness(true);
    const created = await proposePrivacyErase(harness.workflow);

    await expect(acceptPrivacyErase(harness.workflow, created.proposal_id)).rejects.toThrow(
      /Failed to accept privacy erase proposal/u
    );

    expect(readSourceBody(harness.database)).toBe(SENSITIVE_MARKER);
    expect(harness.eraseRepo.findById(WORKSPACE_ID, BARRIER_ID)).toBeNull();
    await expect(harness.proposalRepo.findScopedById(created.proposal_id)).resolves.toMatchObject({
      reviewer_identity: null,
      proposal: { resolution_state: ProposalResolutionState.PENDING }
    });
    const events = await harness.eventLogRepo.queryByEntity("proposal", created.proposal_id);
    expect(events).toHaveLength(1);
  });

  it("rejects a different SQLite transaction scope before acceptance", async () => {
    const harness = createHarness();
    const foreignDatabase = initDatabase({ filename: ":memory:" });
    databases.add(foreignDatabase);
    const foreignEraseRepo = new SqliteFieldEraseBarrierRepo(
      foreignDatabase,
      fieldContractSha256
    );
    const foreignEffectPort = createEffectDecisionPort(foreignDatabase, foreignEraseRepo);
    const workflow = createWorkflow(
      harness.proposalRepo,
      harness.eventLogRepo,
      foreignEraseRepo,
      foreignEffectPort
    );
    const created = await proposePrivacyErase(workflow);

    await expect(acceptPrivacyErase(workflow, created.proposal_id)).rejects.toThrow(
      /transaction scope/u
    );
    expect(readSourceBody(harness.database)).toBe(SENSITIVE_MARKER);
    await expect(harness.proposalRepo.findById(created.proposal_id)).resolves.toMatchObject({
      resolution_state: ProposalResolutionState.PENDING
    });
  });

  it("fails closed when a repository ignores the required erase mutation", async () => {
    const harness = createHarness();
    const ignoredRepo = Object.create(harness.proposalRepo) as SqliteProposalRepo;
    ignoredRepo.acceptPendingPrivacyEraseWithEvents = async (proposalId) => ({
      proposal: (await harness.proposalRepo.findById(proposalId))!,
      events: []
    });
    const workflow = createWorkflow(
      ignoredRepo, harness.eventLogRepo, harness.eraseRepo, harness.effectPort
    );
    const created = await proposePrivacyErase(workflow);

    await expect(acceptPrivacyErase(workflow, created.proposal_id)).rejects.toThrow(
      /omitted its mutation/u
    );
    expect(readSourceBody(harness.database)).toBe(SENSITIVE_MARKER);
    expect(harness.eraseRepo.findById(WORKSPACE_ID, BARRIER_ID)).toBeNull();
  });

  it("accepts atomically after the shared database owner reopens", async () => {
    const harness = createHarness(false, true);
    const created = await proposePrivacyErase(harness.workflow);
    harness.database.close();

    await expect(acceptPrivacyErase(harness.workflow, created.proposal_id)).resolves.toMatchObject({
      resolution_state: ProposalResolutionState.ACCEPTED
    });
    expect(harness.database.getConnectionVersion()).toBe(1);
    expect(readSourceBody(harness.database)).toBeNull();
    expect(harness.eraseRepo.findById(WORKSPACE_ID, BARRIER_ID)).not.toBeNull();
  });

  it("fails closed without a proof-effect decision store", async () => {
    const harness = createHarness();
    const workflow = createWorkflow(
      harness.proposalRepo, harness.eventLogRepo, harness.eraseRepo, undefined
    );
    const created = await proposePrivacyErase(workflow);

    await expect(acceptPrivacyErase(workflow, created.proposal_id)).rejects.toThrow(
      /hard-effect decision ports/u
    );
    expect(readSourceBody(harness.database)).toBe(SENSITIVE_MARKER);
    expect(countRows(harness.database, "proof_effect_decisions")).toBe(0);
  });

  it("rolls back a review that lacks run-bound durable authority", async () => {
    const harness = createHarness();
    const created = await proposePrivacyErase(harness.workflow, null);

    await expect(harness.workflow.reviewMemoryProposal(
      reviewRequest(created.proposal_id, "accept"),
      reviewContext(null)
    )).rejects.toThrow(/Failed to accept privacy erase proposal/u);
    expect(readSourceBody(harness.database)).toBe(SENSITIVE_MARKER);
    expect(countRows(harness.database, "proof_effect_decisions")).toBe(0);
    await expect(harness.proposalRepo.findById(created.proposal_id)).resolves.toMatchObject({
      resolution_state: ProposalResolutionState.PENDING
    });
  });
});

function createHarness(failAfterErase = false, reopenable = false) {
  const directory = reopenable ? mkdtempSync(join(tmpdir(), "alaya-privacy-proposal-")) : null;
  if (directory !== null) tempDirectories.add(directory);
  const database = initDatabase({
    filename: directory === null ? ":memory:" : join(directory, "privacy.db")
  });
  databases.add(database);
  seedWorkspaceAndSource(database);
  const eraseRepo = new SqliteFieldEraseBarrierRepo(database, fieldContractSha256);
  const proposalRepo = new SqliteProposalRepo(database);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const ids = [PROPOSAL_ID, BARRIER_ID];
  const privacyErasePort = failAfterErase
    ? {
        transactionScope: eraseRepo.transactionScope,
        apply: (barrier: Parameters<typeof eraseRepo.apply>[0]) => {
          eraseRepo.apply(barrier);
          throw new Error("injected erase failure");
        }
      }
    : eraseRepo;
  const effectPort = createEffectDecisionPort(database, eraseRepo);
  const workflow = createWorkflow(proposalRepo, eventLogRepo, privacyErasePort, effectPort, ids);
  return { database, effectPort, eraseRepo, eventLogRepo, proposalRepo, workflow };
}

function createWorkflow(
  proposalRepo: SqliteProposalRepo,
  eventLogRepo: SqliteEventLogRepo,
  privacyErasePort: Pick<SqliteFieldEraseBarrierRepo, "transactionScope" | "apply">,
  privacyEffectDecisionStore: ReturnType<typeof createEffectDecisionPort> | undefined,
  ids = [PROPOSAL_ID, BARRIER_ID]
) {
  return createMcpMemoryProposalWorkflow({
    eventLogRepo,
    proposalRepo,
    privacyErasePort,
    ...(privacyEffectDecisionStore === undefined ? {} : { privacyEffectDecisionStore }),
    runtimeNotifier: { notifyEntry: async () => {} },
    reviewerIdentityBinding: { identity: "reviewer", token: "reviewer-token" },
    generateObjectId: () => ids.shift() ?? "33333333-3333-4333-8333-333333333333",
    now: () => TIMESTAMP
  });
}

function seedWorkspaceAndSource(database: StorageDatabase): void {
  new SqliteWorkspaceRepo(database).create({
    workspace_id: WORKSPACE_ID,
    name: "privacy erase",
    root_path: "/tmp/privacy-erase",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  database.connection.prepare(`
    INSERT INTO source_records (
      workspace_id, record_id, source_id, source_version, content_digest,
      evidence_object_id, recorded_at, event_time, valid_from, valid_to,
      operator_id, source_body
    ) VALUES (?, ?, 'test-source', '1', 'digest', NULL, ?, NULL, NULL, NULL,
      'test-operator', ?)
  `).run(WORKSPACE_ID, RECORD_ID, TIMESTAMP, SENSITIVE_MARKER);
}

function proposePrivacyErase(
  workflow: ReturnType<typeof createMcpMemoryProposalWorkflow>,
  runId: string | null = RUN_ID
) {
  return workflow.proposeMemoryUpdate(
    {
      operation: "privacy_erase",
      target_object_id: RECORD_ID,
      reason: "user_requested_deletion"
    },
    { workspaceId: WORKSPACE_ID, runId, agentTarget: "codex", sessionId: "session-1" }
  );
}

function acceptPrivacyErase(
  workflow: ReturnType<typeof createMcpMemoryProposalWorkflow>,
  proposalId: string
) {
  return workflow.reviewMemoryProposal(reviewRequest(proposalId, "accept"), reviewContext());
}

function reviewRequest(proposalId: string, verdict: "accept" | "reject") {
  return {
    proposal_id: proposalId,
    verdict,
    reason: SENSITIVE_MARKER,
    reviewer_identity: "reviewer",
    reviewer_token: "reviewer-token"
  } as const;
}

function reviewContext(runId: string | null = RUN_ID) {
  return {
    workspaceId: WORKSPACE_ID,
    runId,
    agentTarget: "inspector",
    sessionId: "session-1"
  } as const;
}

function createEffectDecisionPort(
  database: StorageDatabase,
  eraseRepo: SqliteFieldEraseBarrierRepo
) {
  const repo = new SqliteFieldProofEffectRepo(database, fieldContractSha256);
  return {
    transactionScope: eraseRepo.transactionScope,
    store: {
      insert(receipt: EffectDecisionReceipt): EffectDecisionReceipt {
        repo.insert({
          ...receipt,
          supporting_receipt_ids_json: JSON.stringify(receipt.supporting_receipt_ids),
          supporting_proof_witnesses_json: JSON.stringify(receipt.supporting_proof_witnesses)
        });
        return receipt;
      }
    },
    lookup: createPrivacyEffectLookup(eraseRepo)
  };
}

function eraseReceiptIdentity(): string {
  return hashLabeledIdentity(
    "erase_barrier",
    [WORKSPACE_ID, "source_record", RECORD_ID, ""],
    fieldContractSha256
  );
}

function countRows(database: StorageDatabase, table: string): number {
  return (database.connection.prepare(`SELECT count(*) AS count FROM ${table}`).get() as
    { readonly count: number }).count;
}

function readEffectDecision(database: StorageDatabase): unknown {
  const row = database.connection.prepare(`
    SELECT action, target, decision, supporting_proof_witnesses_json
    FROM proof_effect_decisions LIMIT 1
  `).get() as {
    readonly action: string;
    readonly target: string;
    readonly decision: string;
    readonly supporting_proof_witnesses_json: string;
  };
  const witnesses = JSON.parse(row.supporting_proof_witnesses_json) as
    readonly { readonly kind: string }[];
  return { ...row, witness_kinds: witnesses.map((witness) => witness.kind) };
}

function countEventType(database: StorageDatabase, eventType: string): number {
  return (database.connection.prepare(`
    SELECT count(*) AS count FROM event_log WHERE event_type = ?
  `).get(eventType) as { readonly count: number }).count;
}

function readSourceBody(database: StorageDatabase): string | null {
  const row = database.connection.prepare(`
    SELECT source_body FROM source_records WHERE workspace_id = ? AND record_id = ?
  `).get(WORKSPACE_ID, RECORD_ID) as { readonly source_body: string | null };
  return row.source_body;
}

function readPrivacyAuditText(database: StorageDatabase): string {
  const proposalRows = database.connection.prepare(`
    SELECT proposed_change_summary, proposed_changes FROM proposals
  `).all();
  const eventRows = database.connection.prepare(`
    SELECT payload_json, caused_by FROM event_log
  `).all();
  return JSON.stringify({ proposalRows, eventRows });
}
