import { afterEach, describe, expect, it } from "vitest";
import {
  ProposalResolutionState,
  WorkspaceKind,
  WorkspaceState,
  type EffectDecisionReceipt
} from "@do-soul/alaya-protocol";
import { EventPublisher, fieldContractSha256 } from "@do-soul/alaya-core";
import {
  initDatabase,
  SqliteEventLogRepo,
  SqliteFieldCausalUsageRepo,
  SqliteFieldEraseBarrierRepo,
  SqliteFieldProofEffectRepo,
  SqliteProposalRepo,
  SqliteWorkspaceRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { createDaemonMcpMemoryToolHandler } from "../../../mcp-memory/tool/daemon-handler.js";
import { createSqliteCausalUsagePort } from "../../../runtime/field/sqlite-causal-usage-port.js";
import { createDeps } from "./mcp-memory-tool-handler-fixture.js";

const WORKSPACE_ID = "workspace-privacy-erase";
const RECORD_ID = "source-record-private";
const TIMESTAMP = "2026-08-17T00:00:00.000Z";
const SENSITIVE_MARKER = "PRIVATE_DELETE_CONTEXT_7f4d";
const RUN_ID = "run-privacy-erase";
const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("daemon privacy erase wiring", () => {
  it("accepts privacy erase through the production daemon handler ports", async () => {
    const harness = createHarness();
    const handler = createDaemonHandler(harness);
    const proposed = await handler.call({
      toolName: "soul.propose_memory_update",
      arguments: {
        operation: "privacy_erase",
        target_object_id: RECORD_ID,
        reason: "user_requested_deletion"
      },
      context: proposeContext()
    });
    expect(proposed).toMatchObject({ ok: true });
    const proposalId = (proposed as { readonly output: { readonly proposal_id: string } })
      .output.proposal_id;

    const reviewed = await handler.call({
      toolName: "soul.review_memory_proposal",
      arguments: {
        proposal_id: proposalId,
        verdict: "accept",
        reason: SENSITIVE_MARKER,
        reviewer_identity: "reviewer",
        reviewer_token: "reviewer-token"
      },
      context: reviewContext()
    });

    expect(reviewed).toMatchObject({
      ok: true,
      output: { resolution_state: ProposalResolutionState.ACCEPTED }
    });
    expect(harness.database.connection.prepare(
      "SELECT COUNT(*) AS count FROM proof_effect_decisions"
    ).get()).toEqual({ count: 1 });
    expect(harness.database.connection.prepare(
      "SELECT source_body FROM source_records WHERE workspace_id = ? AND record_id = ?"
    ).get(WORKSPACE_ID, RECORD_ID)).toEqual({ source_body: null });
  });
});

function createDaemonHandler(harness: ReturnType<typeof createHarness>) {
  const deps = createDeps();
  return createDaemonMcpMemoryToolHandler({
    zeroDayToolAccess: { enforceToolAccess: async () => undefined },
    recallService: deps.recallService,
    memoryService: deps.memoryService,
    memoryEntryRepo: { updateTier: () => null },
    signalService: deps.signalService,
    graphExploreService: deps.graphExploreService,
    sessionOverrideService: deps.sessionOverrideService,
    trustStateRecorder: deps.trustStateRecorder,
    eventPublisher: harness.eventPublisher,
    eventLogRepo: harness.eventLogRepo,
    proposalRepo: harness.proposalRepo,
    privacyErasePort: harness.eraseRepo,
    privacyEffectDecisionStore: harness.effectPort,
    runtimeNotifier: { notifyEntry: async () => undefined },
    resolutionService: {
      resolve: async () => {
        throw new Error("soul.resolve is not under test");
      }
    },
    causalUsagePort: harness.usagePort,
    reviewerIdentityBinding: { identity: "reviewer", token: "reviewer-token" }
  });
}

function createHarness() {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
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
  const eventLogRepo = new SqliteEventLogRepo(database);
  const eraseRepo = new SqliteFieldEraseBarrierRepo(database, fieldContractSha256);
  const effectRepo = new SqliteFieldProofEffectRepo(database, fieldContractSha256);
  return {
    database,
    eventLogRepo,
    proposalRepo: new SqliteProposalRepo(database),
    eraseRepo,
    effectPort: {
      transactionScope: eraseRepo.transactionScope,
      store: {
        insert(receipt: EffectDecisionReceipt): EffectDecisionReceipt {
          effectRepo.insert({
            ...receipt,
            supporting_receipt_ids_json: JSON.stringify(receipt.supporting_receipt_ids),
            supporting_proof_witnesses_json: JSON.stringify(receipt.supporting_proof_witnesses)
          });
          return receipt;
        }
      }
    },
    eventPublisher: new EventPublisher({
      eventLogRepo,
      runHotStateService: { apply: () => undefined },
      runtimeNotifier: { notify: () => undefined, notifyEntry: () => undefined }
    }),
    usagePort: createSqliteCausalUsagePort({
      repo: new SqliteFieldCausalUsageRepo(database, fieldContractSha256),
      sha256: fieldContractSha256
    })
  };
}

function proposeContext() {
  return {
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    agentTarget: "codex",
    sessionId: "session-1"
  } as const;
}

function reviewContext() {
  return {
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    agentTarget: "inspector",
    sessionId: "session-1"
  } as const;
}
