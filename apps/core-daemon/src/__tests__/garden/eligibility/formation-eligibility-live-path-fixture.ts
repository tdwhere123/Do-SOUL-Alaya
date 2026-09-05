import { createHash } from "node:crypto";
import {
  QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID,
  buildVerifiedUserAssertionReceiptV2Preimage,
  certifyQueryOsfSemanticCompleteness,
  formatVerifiedUserAssertionV2SourceHash,
  hashDerivationJobId,
  type CandidateMemorySignal,
  type OpenSemanticFactorFormationCapture
} from "@do-soul/alaya-protocol";
import {
  EvidenceService,
  RULE_BASED_EVIDENCE_FACT_FRAME_PROPOSAL_NORMALIZER,
  RuleBasedQueryFactFrameExtractor,
  SignalService,
  fieldContractSha256
} from "@do-soul/alaya-core";
import {
  InMemoryHandoffGapHandler,
  MaterializationRouter,
  verifyOfficialApiSourceLocatorBinding
} from "@do-soul/alaya-soul";
import {
  SqliteEventLogRepo,
  SqliteEvidenceCapsuleRepo,
  SqliteSignalRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { readStoredSemanticFactorFormation } from
  "../../../../../../packages/storage/src/repos/capsules/reads/qualification/semantic-factor-formation-read.js";
import { createMemoryEntry } from
  "../../../../../../packages/core/src/__tests__/recall/recall-service-test-fixtures.js";
import {
  binaryUseQuerySemanticGraph,
  collectWith,
  emptyGraphSupportPort
} from "../../../../../../packages/core/src/__tests__/recall/supplementary-data-test-fixtures.js";
import {
  CLOCK,
  EVIDENCE_ID,
  MEMORY_ID,
  WORKSPACE_ID,
  composeField,
  createPlantedHarness,
  type PlantedField
} from "../../runtime/field/p217-planted-harness.js";

export const planted = createPlantedHarness();
export const ASSERTION = "I used Atlas.";
export const QUERY = "What did I use?";
const CORPUS = `User: ${ASSERTION}`;

export interface EligibilityLiveRuntime {
  readonly field: PlantedField;
  readonly evidenceRepo: SqliteEvidenceCapsuleRepo;
  readonly signalService: SignalService;
  readonly database: StorageDatabase;
}

export async function openEligibilityRuntime(): Promise<EligibilityLiveRuntime> {
  const database = planted.openMemoryDatabase();
  const field = composeField(database);
  const evidenceRepo = new SqliteEvidenceCapsuleRepo(
    database,
    verifyOfficialApiSourceLocatorBinding
  );
  const eventLogRepo = new SqliteEventLogRepo(database);
  const runtimeNotifier = { notifyEntry: async () => undefined };
  const evidenceService = new EvidenceService({
    evidenceCapsuleRepo: evidenceRepo,
    eventLogRepo,
    runtimeNotifier,
    generateObjectId: () => EVIDENCE_ID,
    now: () => CLOCK,
    sha256: fieldContractSha256,
    fieldStores: field.stores,
    factFrameProposalNormalizer: RULE_BASED_EVIDENCE_FACT_FRAME_PROPOSAL_NORMALIZER
  });
  const router = new MaterializationRouter({
    evidenceService,
    memoryService: stubMaterializationCreate("memory_entry", "memory-1"),
    synthesisService: stubMaterializationCreate("synthesis_capsule", "synthesis-1"),
    claimService: stubMaterializationCreate("claim_form", "claim-1"),
    handoffGapHandler: new InMemoryHandoffGapHandler(),
    fullTurnEvidenceExcerpt: true
  });
  return {
    field,
    evidenceRepo,
    database,
    signalService: new SignalService({
      eventLogRepo,
      signalRepo: new SqliteSignalRepo(database),
      runtimeNotifier,
      postTriageMaterializer: {
        materialize: async (signal, context) =>
          await router.materializeSignal(signal, context)
      }
    })
  };
}

function stubMaterializationCreate(object_kind: string, object_id: string) {
  return {
    create: async () => ({ object_kind, object_id })
  };
}

const SOURCE_LOCATOR = Object.freeze({
  contract_version: 2 as const,
  kind: "assertion_catalog" as const,
  assertion_id: 1
});

const GROUNDED_SOURCE_AUDIT = Object.freeze({
  version: 1,
  status: "grounded" as const,
  content_basis: "source_assertion",
  source_assertion: ASSERTION,
  proposed_matched_text: ASSERTION,
  reasons: Object.freeze([])
});

export function assertionSignal(
  signalId: string,
  payload: Readonly<Record<string, unknown>>
): CandidateMemorySignal {
  return {
    signal_id: signalId,
    workspace_id: WORKSPACE_ID,
    run_id: "run-1",
    surface_id: null,
    source: "garden_compile",
    signal_kind: "potential_claim",
    signal_state: "emitted",
    object_kind: "review_scope",
    scope_hint: null,
    domain_tags: ["atlas"],
    confidence: 0.9,
    evidence_refs: ["msg-1"],
    source_memory_refs: [],
    supersedes_refs: [],
    exception_to_refs: [],
    contradicts_refs: [],
    incompatible_with_refs: [],
    raw_payload: {
      matched_text: ASSERTION,
      distilled_fact: ASSERTION,
      source_assertion: ASSERTION,
      full_turn_content: CORPUS,
      source_locator: SOURCE_LOCATOR,
      verified_user_assertion_source_hash: verifiedAssertionHash(signalId),
      source_grounding: GROUNDED_SOURCE_AUDIT,
      ...payload
    },
    created_at: CLOCK,
    source_observation: null
  };
}

// invariant: a present hash that cannot rebuild is router source-grounding
// defer, not eligibility. Drop the key to reach createSignalEvidence.
export function withoutVerifiedAssertionHash(
  signal: CandidateMemorySignal
): CandidateMemorySignal {
  const { verified_user_assertion_source_hash: _, ...raw_payload } = signal.raw_payload;
  return { ...signal, raw_payload };
}

function verifiedAssertionHash(signalId: string): string {
  return formatVerifiedUserAssertionV2SourceHash(
    createHash("sha256").update(buildVerifiedUserAssertionReceiptV2Preimage({
      signal_id: signalId,
      source_locator: SOURCE_LOCATOR,
      workspace_id: WORKSPACE_ID,
      run_id: "run-1",
      surface_id: null,
      source_assertion: ASSERTION,
      source_corpus: CORPUS
    }), "utf8").digest("hex")
  );
}

export function createdEvidenceId(
  received: Awaited<ReturnType<SignalService["receiveSignal"]>>
): string | undefined {
  return received.materialization?.success === true
    ? received.materialization.created_objects[0]?.object_id
    : undefined;
}

export async function readQualifiedCapture(
  repo: SqliteEvidenceCapsuleRepo,
  evidenceId: string
): Promise<OpenSemanticFactorFormationCapture | undefined> {
  const qualified = await readQualifiedEvidence(repo, evidenceId);
  return qualified[0]?.semantic_factor_formation;
}

export async function readQualifiedEvidence(
  repo: SqliteEvidenceCapsuleRepo,
  evidenceId: string
) {
  return await repo.findRecallQualifiedByIds(WORKSPACE_ID, [
    { object_id: evidenceId }
  ]);
}

export function readDurableFormation(
  database: StorageDatabase,
  evidenceId: string
): OpenSemanticFactorFormationCapture | undefined {
  const row = database.connection.prepare(`
    SELECT workspace_id AS semantic_formation_workspace_id,
           schema_version AS semantic_formation_schema_version,
           operator_id AS semantic_formation_operator_id,
           status AS semantic_formation_status,
           producer_operator_id AS semantic_formation_producer_operator_id,
           source_sha256 AS semantic_formation_source_sha256,
           graph_json AS semantic_formation_graph_json,
           capture_digest AS semantic_formation_capture_digest
    FROM evidence_semantic_factor_formations
    WHERE evidence_object_id = ?
  `).get(evidenceId);
  const evidence = database.connection.prepare(`
    SELECT excerpt FROM evidence_capsules WHERE object_id = ?
  `).get(evidenceId) as { readonly excerpt: string | null } | undefined;
  return row === undefined
    ? undefined
    : readStoredSemanticFactorFormation(
      row as Parameters<typeof readStoredSemanticFactorFormation>[0],
      WORKSPACE_ID,
      evidence?.excerpt ?? null,
      undefined
    );
}

export async function collectLiveSupplement(
  repo: SqliteEvidenceCapsuleRepo,
  evidenceId: string
) {
  return await collectWith({
    candidates: [createMemoryEntry({
      object_id: MEMORY_ID,
      content: ASSERTION,
      evidence_refs: [evidenceId]
    })],
    graphSupportPort: emptyGraphSupportPort(),
    queryText: QUERY,
    queryFactFrameExtractionPort: new RuleBasedQueryFactFrameExtractor(),
    openSemanticFactorExtractionPort: certifiedQueryPort(),
    evidenceSearchPort: repo
  });
}

export function f3Factors(field: PlantedField) {
  return field.stores.listFactors(WORKSPACE_ID).filter((factor) => factor.family === "f3");
}

export function f3CaptureJob(field: PlantedField, producer: string) {
  return field.stores.getJob(WORKSPACE_ID, hashDerivationJobId({
    purpose: "f3_semantic_capture",
    operator_id: producer,
    input_evidence_ids: [EVIDENCE_ID]
  }, fieldContractSha256));
}

function certifiedQueryPort() {
  return {
    operator_id: "test_open_semantic_factor_v1",
    extract: async () => null,
    extractCertifiedQuery: async (
      sourceText: string,
      obligation: Parameters<typeof certifyQueryOsfSemanticCompleteness>[0]["obligation"]
    ) => {
      const graph = binaryUseQuerySemanticGraph();
      const receipt = certifyQueryOsfSemanticCompleteness({
        query_text: sourceText,
        graph,
        obligation,
        producer_operator_id: QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID,
        sha256: (value) => createHash("sha256").update(value, "utf8").digest("hex")
      });
      return receipt === null ? null : {
        schema_version: 1 as const,
        producer_operator_id: QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID,
        graph,
        semantic_completeness_receipt: receipt
      };
    }
  };
}
