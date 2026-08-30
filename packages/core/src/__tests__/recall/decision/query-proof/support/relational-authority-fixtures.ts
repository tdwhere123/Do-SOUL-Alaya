import { digestRecallFieldIdentity } from
  "../../../../../recall/field/field-identity.js";
import {
  createSnapshotCoherenceReceiptV1,
  createSnapshotVectorV1,
  finalizePreparedSnapshotReadLease,
  readSnapshotLeaseCapability,
  type SourceFrontierDeclarationV1
} from "../../../../../recall/runtime/snapshot-coherence/index.js";
import type {
  SupportRelationalSourceObservationReceiptV1,
  SupportRelationalSourceVerifierV1,
  SupportRelationalSubjectV1
} from "../../../../../recall/decision/query-proof/support/index.js";
import { materializeSupportFromReceipts } from
  "../../../../../recall/decision/query-proof/support/index.js";
import { QUERY } from "./fixtures.js";

const AS_OF = "2026-08-29T00:00:00.000Z";
const TX_FRONTIER = "tx-frontier-1";
const RELATIONAL_SCOPE = "recall.relational";
const CAND = "workspace_local:memory_entry:cand-1";
const TEST_OBSERVATIONS = new Map<string, Set<string>>();
const TEST_SOURCE_VERIFIERS: readonly SupportRelationalSourceVerifierV1[] = Object.freeze([
  testSourceVerifier("path_relations", ["path_projection"]),
  testSourceVerifier("relation_assertions", ["polarity", "contradiction", "supersession"])
]);

export const AUTHORITY_CONTEXT = createAuthorityContext();
export const RELATIONAL_SNAPSHOT = AUTHORITY_CONTEXT.snapshot_vector.vector_digest;

export function authorityContext(): typeof AUTHORITY_CONTEXT {
  return AUTHORITY_CONTEXT;
}

export function relationalReceipt(overrides: Record<string, unknown> = {}) {
  const subject = (overrides.subject ?? pathSubject()) as SupportRelationalSubjectV1;
  return createRelationalReceipt(AUTHORITY_CONTEXT, subject, overrides);
}

export function pathMaterialization(
  extras: { strength?: number; hop?: number; path_count?: number },
  receipt = pathReceipt()
) {
  return materializePath(authorityContext(), receipt, extras);
}

export function materializePath(
  context: ReturnType<typeof createAuthorityContext>,
  receipt: ReturnType<typeof pathReceipt> | undefined,
  extras: { strength?: number; hop?: number; path_count?: number } = {}
) {
  return materializeSupportFromReceipts({
    query_id: QUERY,
    snapshot_digest: context.snapshot_vector.vector_digest,
    authority_context: context,
    candidates: [{
      candidate_key: CAND,
      path: {
        evidence_basis: ["eu-path", "eu-path"],
        relation_kind: "works_at",
        proposition_id: "prop.works-at",
        receipt,
        ...extras
      }
    }]
  });
}

export function polarityCandidate(
  candidateKey: string,
  lineageId: string,
  polarity: "positive" | "negative",
  receipt?: ReturnType<typeof relationalReceipt>
) {
  return {
    candidate_key: candidateKey,
    polarity: {
      status: "available" as const,
      value: {
        polarity,
        lineage_id: lineageId,
        proposition_id: "prop.works-at",
        ...(receipt === undefined ? {} : { receipt })
      }
    },
    evidence_ids: [`eu-${lineageId}`],
    contradiction: polarity === "negative"
      ? {
          status: "available" as const,
          value: {
            standing: "contradicting" as const,
            lineage_id: lineageId,
            proposition_id: "prop.works-at",
            ...(receipt === undefined ? {} : { receipt: contradictionReceipt(lineageId) })
          }
        }
      : undefined
  };
}

export function createRelationalReceipt(
  context: ReturnType<typeof createAuthorityContext>,
  subject: SupportRelationalSubjectV1,
  overrides: Record<string, unknown>
) {
  const { subject: _subject, test_source_owner, ...tamper } = overrides;
  const sourceOwner = typeof test_source_owner === "string"
    ? test_source_owner
    : subject.kind === "path_projection"
      ? "path_relations"
      : "relation_assertions";
  const capability = readSnapshotLeaseCapability(context.read_lease, sourceOwner);
  const declaration = capability.declaration;
  const observationBody = {
    schema_version: 1 as const,
    source_owner: sourceOwner,
    source_observation_id: `test-observation:${digestRecallFieldIdentity(subject)}`,
    source_frontier: declaration.source_frontier,
    generation: declaration.generation,
    producer_operator_id: "relation_assertion_projection_v1",
    producer_operator_version: "1",
    subject
  };
  const source_observation = Object.freeze({
    ...observationBody,
    observation_digest: digestRecallFieldIdentity(observationBody)
  });
  TEST_OBSERVATIONS.get(sourceOwner)!.add(source_observation.observation_digest);
  const body = relationalBody(context, capability, source_observation, subject);
  return { ...body, receipt_digest: digestRecallFieldIdentity(body), ...tamper };
}

export function resealRelationalReceipt(
  receipt: ReturnType<typeof createRelationalReceipt>
): ReturnType<typeof createRelationalReceipt> {
  const { receipt_digest: _receiptDigest, ...body } = receipt;
  return { ...body, receipt_digest: digestRecallFieldIdentity(body) };
}

export function pathSubject(): SupportRelationalSubjectV1 {
  return { kind: "path_projection", proposition_id: "prop.works-at", relation_kind: "works_at" };
}

export function pathReceipt(overrides: Record<string, unknown> = {}) {
  return relationalReceipt({ subject: pathSubject(), ...overrides });
}

export function polarityReceipt(lineage_id: string) {
  return relationalReceipt({
    subject: { kind: "polarity" as const, proposition_id: "prop.works-at", lineage_id }
  });
}

export function contradictionReceipt(lineage_id: string) {
  return relationalReceipt({
    subject: { kind: "contradiction" as const, proposition_id: "prop.works-at", lineage_id }
  });
}

export function supersessionReceipt(
  lineage_id: string,
  proposition_id: string,
  counterpart_proposition_id?: string
) {
  return relationalReceipt({
    subject: {
      kind: "supersession" as const,
      proposition_id,
      lineage_id,
      ...(counterpart_proposition_id === undefined ? {} : { counterpart_proposition_id })
    }
  });
}

export function createAuthorityContext(options: Readonly<{
  readonly sourceView?: "pinned" | "unavailable";
  readonly validTime?: SourceFrontierDeclarationV1["valid_time_domain"];
  readonly includeVerifiers?: boolean;
  readonly generation?: string;
}> = {}) {
  const declaration = sourceDeclaration(options);
  const snapshot_vector = createSnapshotVectorV1({
    principal: "principal-1",
    authorized_scopes: [RELATIONAL_SCOPE],
    effective_as_of: AS_OF,
    transaction_frontier: TX_FRONTIER,
    base_store_digest: `sha256:${"a".repeat(64)}`,
    projection_generation: declaration("projection_generation"),
    retrieval_channel_snapshots: [declaration("path_relations"), declaration("relation_assertions")],
    embedding_generation_and_model: declaration("embedding_generation_and_model"),
    path_graph_generation: declaration("path_graph_generation"),
    temporal_index_generation: declaration("temporal_index_generation"),
    governance_frontier: declaration("governance_frontier"),
    formation_operator_versions: [["relation_assertion_projection_v1", "1"]],
    decision_contract_digest: `sha256:${"b".repeat(64)}`
  });
  const read_lease = finalizePreparedSnapshotReadLease(snapshot_vector);
  return Object.freeze({
    snapshot_vector,
    snapshot_receipt: createSnapshotCoherenceReceiptV1(snapshot_vector),
    read_lease,
    ...(options.includeVerifiers === false
      ? {}
      : { relational_source_verifiers: TEST_SOURCE_VERIFIERS })
  });
}

function relationalBody(
  context: ReturnType<typeof createAuthorityContext>,
  capability: ReturnType<typeof readSnapshotLeaseCapability>,
  source_observation: SupportRelationalSourceObservationReceiptV1,
  subject: SupportRelationalSubjectV1
) {
  const declaration = capability.declaration;
  return {
    schema_version: 1 as const,
    operator_id: "support_relational_receipt_v1" as const,
    query_id: QUERY,
    snapshot_digest: context.snapshot_vector.vector_digest,
    snapshot_receipt_digest: context.snapshot_receipt.receipt_digest,
    snapshot_lease_id: context.read_lease.lease_id,
    effective_as_of: context.snapshot_vector.effective_as_of,
    transaction_frontier: context.snapshot_vector.transaction_frontier,
    source_owner: capability.source_owner,
    principal: declaration.principal,
    source_frontier: declaration.source_frontier,
    generation: declaration.generation,
    producer_operator_id: "relation_assertion_projection_v1",
    producer_operator_version: "1",
    operator_or_model_version: declaration.operator_or_model_version,
    authorized_scope: declaration.authorized_scope,
    lag_bound: declaration.lag_bound,
    view_kind: capability.view_kind,
    valid_time_domain: declaration.valid_time_domain,
    source_receipt_digest: digestRecallFieldIdentity(source_observation),
    source_observation,
    subject
  };
}

function testSourceVerifier(
  source_owner: string,
  allowed_subject_kinds: readonly SupportRelationalSubjectV1["kind"][]
): SupportRelationalSourceVerifierV1 {
  const admitted = new Set<string>();
  TEST_OBSERVATIONS.set(source_owner, admitted);
  return Object.freeze({
    source_owner,
    allowed_subject_kinds: Object.freeze([...allowed_subject_kinds]),
    verifySourceObservation(receipt: SupportRelationalSourceObservationReceiptV1): boolean {
      const { observation_digest, ...body } = receipt;
      return admitted.has(observation_digest)
        && digestRecallFieldIdentity(body) === observation_digest;
    }
  });
}

function sourceDeclaration(options: Readonly<{
  readonly sourceView?: "pinned" | "unavailable";
  readonly validTime?: SourceFrontierDeclarationV1["valid_time_domain"];
}>) {
  return (source_owner: string): SourceFrontierDeclarationV1 => ({
    source_owner,
    principal: "principal-1",
    authorized_scope: RELATIONAL_SCOPE,
    source_frontier: TX_FRONTIER,
    valid_time_domain: options.validTime
      ?? { kind: "open", from: "2026-08-01T00:00:00.000Z" },
    generation: options.generation ?? "generation-1",
    operator_or_model_version: "operator-1",
    lag_bound: source_owner === "path_relations" && options.sourceView === "unavailable"
      ? { kind: "unavailable" }
      : { kind: "exact" }
  });
}
