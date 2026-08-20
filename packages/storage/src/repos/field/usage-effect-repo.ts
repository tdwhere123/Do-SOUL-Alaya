import {
  GovernanceResolutionPayloadSchema,
  ProofEffectWitnessSchema,
  canonicalEffectClaimFact,
  canonicalEffectMemoryFact,
  hashCorrectionPredecessorId,
  hashCorrectionSuccessorId,
  hashEffectDecisionFactSnapshot,
  hashContentDigest,
  type FieldContractSha256,
  type ProofEffectWitness
} from "@do-soul/alaya-protocol";
import { StorageError } from "../../shared/errors.js";
import type { StorageDatabase } from "../../sqlite/db.js";
import { RefreshableStatementHolder } from "../../sqlite/refreshable-statement-holder.js";
import { parseOptionalRow } from "../shared/parse-row.js";
import { verifyPersistedEffect, verifyPersistedUsage } from "./identity.js";
import {
  fieldCausalUsageParser,
  fieldProofEffectParser,
  insertIdempotent
} from "./mappers.js";
import type {
  FieldCausalUsageRepo,
  FieldCausalUsageRow,
  FieldProofEffectRepo,
  FieldProofEffectRow
} from "./ports.js";

export class SqliteFieldCausalUsageRepo implements FieldCausalUsageRepo {
  private readonly insertStatement;
  private readonly selectStatement;
  private readonly listAtAsOfStatement;

  public constructor(
    database: StorageDatabase,
    private readonly sha256: FieldContractSha256
  ) {
    this.insertStatement = database.connection.prepare(`
      INSERT INTO causal_usage_receipts (
        identity, workspace_id, causal_key, occurred_at, downstream_ref,
        weight, scope, usage_kind, operator_id, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, identity) DO NOTHING
    `);
    this.selectStatement = database.connection.prepare(`
      SELECT identity, workspace_id, causal_key, occurred_at, downstream_ref,
             weight, scope, usage_kind, operator_id, recorded_at
      FROM causal_usage_receipts WHERE workspace_id = ? AND identity = ? LIMIT 1
    `);
    this.listAtAsOfStatement = database.connection.prepare(`
      SELECT identity, workspace_id, causal_key, occurred_at, downstream_ref,
             weight, scope, usage_kind, operator_id, recorded_at
      FROM causal_usage_receipts
      WHERE workspace_id = ? AND occurred_at <= ? AND recorded_at <= ?
      ORDER BY occurred_at ASC, identity ASC
    `);
  }

  public insert(row: FieldCausalUsageRow) {
    verifyPersistedUsage(row, this.sha256);
    const write = this.insertStatement.run(
      row.identity, row.workspace_id, row.causal_key, row.occurred_at,
      row.downstream_ref, row.weight, row.scope, row.usage_kind,
      row.operator_id, row.recorded_at
    );
    const canonical = this.findById(row.workspace_id, row.identity);
    if (canonical === null || !sameUsageReceipt(canonical, row)) {
      throw new Error("causal usage receipt replay conflict");
    }
    return Object.freeze({ row: canonical, inserted: write.changes === 1 });
  }

  public findById(workspaceId: string, identity: string): FieldCausalUsageRow | null {
    return parseOptionalRow(
      this.selectStatement.get(workspaceId, identity),
      fieldCausalUsageParser,
      "causal usage receipt"
    );
  }

  public listByWorkspaceAtAsOf(
    workspaceId: string,
    asOf: string
  ): readonly FieldCausalUsageRow[] {
    return (this.listAtAsOfStatement.all(workspaceId, asOf, asOf) as readonly unknown[])
      .map((row) => fieldCausalUsageParser.parse(row));
  }
}

function sameUsageReceipt(left: FieldCausalUsageRow, right: FieldCausalUsageRow): boolean {
  return left.causal_key === right.causal_key &&
    left.downstream_ref === right.downstream_ref &&
    left.weight === right.weight &&
    left.scope === right.scope &&
    left.usage_kind === right.usage_kind &&
    left.operator_id === right.operator_id;
}

export class SqliteFieldProofEffectRepo implements FieldProofEffectRepo {
  private readonly statements: RefreshableStatementHolder<ReturnType<typeof prepareEffectStatements>>;

  public constructor(
    private readonly database: StorageDatabase,
    private readonly sha256: FieldContractSha256
  ) {
    this.statements = new RefreshableStatementHolder(database, prepareEffectStatements);
  }

  public insert(row: FieldProofEffectRow): FieldProofEffectRow {
    verifyPersistedEffect(row, this.sha256);
    const existing = this.findById(row.workspace_id, row.request_digest);
    if (existing !== null) {
      if (!sameEffectDecision(existing, row)) {
        throw new StorageError("CONFLICT", "proof effect decision replay conflict");
      }
      return existing;
    }
    this.verifyCommitWitnesses(row);
    return insertIdempotent(
      () => this.statements.active().insertStatement.run(
        row.schema_version, row.request_digest, row.workspace_id, row.actor_id,
        row.run_id, row.delivery_id, row.action, row.target, row.scope,
        row.effective_as_of, row.decision, row.supporting_receipt_ids_json,
        row.supporting_proof_witnesses_json, row.governance_frontier,
        row.policy_operator_id, row.policy_operator_version,
        row.recorded_at
      ),
      () => this.findById(row.workspace_id, row.request_digest),
      (existing) => sameEffectDecision(existing, row),
      "proof effect decision"
    );
  }

  public findById(workspaceId: string, requestDigest: string): FieldProofEffectRow | null {
    return parseOptionalRow(
      this.statements.active().selectStatement.get(workspaceId, requestDigest),
      fieldProofEffectParser,
      "proof effect decision"
    );
  }

  private verifyCommitWitnesses(row: FieldProofEffectRow): void {
    const witnesses = parseProofWitnesses(row.supporting_proof_witnesses_json);
    assertWitnessSet(row.supporting_receipt_ids_json, witnesses);
    if (witnesses.some((witness) =>
      witness.kind === "actor_authority" && witness.authority_event_id === null)) {
      throw new StorageError("VALIDATION_FAILED", "actor proof lacks a durable authority event");
    }
    for (const witness of witnesses.filter(hasSourceWitness)) {
      if (this.statements.active().sourceWitnessStatement.get(
        row.workspace_id,
        witness.source_record_id,
        witness.source_content_digest
      ) === undefined) {
        throw new StorageError("VALIDATION_FAILED", "proof effect source witness is stale");
      }
    }
    const snapshot = witnesses.find((witness) => witness.kind === "governance_snapshot");
    if (snapshot !== undefined) {
      const facts = this.readDecisionFacts(row, witnesses);
      if (snapshot.receipt_id !== hashEffectDecisionFactSnapshot(facts.snapshot, this.sha256)) {
        throw new StorageError("VALIDATION_FAILED", "proof effect governance snapshot is stale");
      }
      if (row.action === "correct") this.verifyCorrectionReceipts(row, witnesses, facts.targetFact);
    }
  }

  private readDecisionFacts(
    row: FieldProofEffectRow,
    witnesses: readonly ProofEffectWitness[]
  ) {
    const actor = witnesses.find((witness) => witness.kind === "actor_authority");
    if (actor?.authority_event_id === null || actor?.authority_event_id === undefined) {
      throw new StorageError("VALIDATION_FAILED", "governance snapshot lacks actor authority");
    }
    const authorityEvent = this.database.connection.prepare(`
      SELECT 1 FROM event_log
      WHERE workspace_id = ? AND event_id = ?
        AND event_type = 'memory.delivered'
        AND entity_type = 'trust_context_delivery'
        AND entity_id = ? AND run_id = ? AND caused_by = ?
        AND json_extract(payload_json, '$.delivery_id') = ?
        AND json_extract(payload_json, '$.agent_target') = ?
      LIMIT 1
    `).get(
      row.workspace_id,
      actor.authority_event_id,
      row.delivery_id,
      row.run_id,
      row.actor_id,
      row.delivery_id,
      row.actor_id
    );
    if (authorityEvent === undefined) {
      throw new StorageError("VALIDATION_FAILED", "governance snapshot authority event is stale");
    }
    const grounded = this.readGroundedEvidenceIds(row.workspace_id);
    const target = this.readTargetFacts(row.workspace_id, row.target, grounded);
    const erased = this.database.connection.prepare(`
      SELECT 1 FROM projection_erase_barriers
      WHERE workspace_id = ? AND subject_id = ? LIMIT 1
    `).get(row.workspace_id, row.target) !== undefined;
    return {
      targetFact: target.targetFact,
      snapshot: {
        target_fact: target.targetFact,
        competing_facts: target.competingFacts,
        erased,
        bridge_revoked: false,
        delivery_authority_event_id: actor.authority_event_id
      }
    };
  }

  private readTargetFacts(
    workspaceId: string,
    targetId: string,
    grounded: ReadonlySet<string>
  ): Readonly<{ targetFact: string; competingFacts: readonly string[] }> {
    const claim = this.readClaimFactRow(workspaceId, targetId);
    if (claim !== null) {
      return {
        targetFact: toClaimFact(claim, grounded, claim.scope_class),
        competingFacts: this.readCompetingClaimRows(workspaceId, claim.canonical_key)
          .map((candidate) => toClaimFact(candidate, grounded, claim.scope_class))
      };
    }
    const memory = this.readMemoryFactRow(workspaceId, targetId);
    return { targetFact: toMemoryFact(memory, this.sha256), competingFacts: [] };
  }

  private verifyCorrectionReceipts(
    row: FieldProofEffectRow,
    witnesses: readonly ProofEffectWitness[],
    targetFact: string
  ): void {
    const eventRow = this.database.connection.prepare(`
      SELECT payload_json FROM event_log
      WHERE workspace_id = ? AND entity_id = ?
        AND event_type = 'soul.resolution.correct_applied'
        AND json_extract(payload_json, '$.delivery_id') = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(row.workspace_id, row.target, row.delivery_id) as { payload_json: string } | undefined;
    if (eventRow === undefined) {
      throw new StorageError("VALIDATION_FAILED", "correction successor audit is missing");
    }
    const payload = GovernanceResolutionPayloadSchema.parse(JSON.parse(eventRow.payload_json));
    const predecessor = witnesses.find((witness) => witness.kind === "predecessor");
    const successor = witnesses.find((witness) => witness.kind === "successor");
    const expectedPredecessor = hashCorrectionPredecessorId({
      workspace_id: row.workspace_id,
      target: row.target,
      target_fact: targetFact
    }, this.sha256);
    const expectedSuccessor = hashCorrectionSuccessorId({
      workspace_id: row.workspace_id,
      target: row.target,
      correction: payload.correction ?? ""
    }, this.sha256);
    if (predecessor?.receipt_id !== expectedPredecessor ||
        successor?.receipt_id !== expectedSuccessor ||
        payload.predecessor_receipt_id !== expectedPredecessor ||
        payload.successor_receipt_id !== expectedSuccessor) {
      throw new StorageError("VALIDATION_FAILED", "correction successor receipts are stale");
    }
  }

  private readClaimFactRow(workspaceId: string, objectId: string): ClaimFactRow | null {
    const row = this.database.connection.prepare(`${CLAIM_FACT_SELECT}
      WHERE workspace_id = ? AND object_id = ? LIMIT 1
    `).get(workspaceId, objectId) as ClaimFactRow | undefined;
    return row ?? null;
  }

  private readMemoryFactRow(workspaceId: string, objectId: string): MemoryFactRow {
    const row = this.database.connection.prepare(`
      SELECT object_id, lifecycle_state, scope_class, created_at, updated_at, content, evidence_refs
      FROM memory_entries WHERE workspace_id = ? AND object_id = ? LIMIT 1
    `).get(workspaceId, objectId) as MemoryFactRow | undefined;
    if (row === undefined) throw new StorageError("VALIDATION_FAILED", "effect target is stale");
    return row;
  }

  private readCompetingClaimRows(workspaceId: string, canonicalKey: string): readonly ClaimFactRow[] {
    return this.database.connection.prepare(`${CLAIM_FACT_SELECT}
      WHERE workspace_id = ?
        AND json_extract(governance_subject, '$.canonical_key') = ?
        AND claim_status NOT IN ('archived', 'rejected', 'superseded')
    `).all(workspaceId, canonicalKey) as readonly ClaimFactRow[];
  }

  private readGroundedEvidenceIds(workspaceId: string): ReadonlySet<string> {
    const rows = this.database.connection.prepare(`
      SELECT DISTINCT ref.evidence_object_id
      FROM source_record_evidence_refs AS ref
      JOIN source_records AS source
        ON source.workspace_id = ref.workspace_id AND source.record_id = ref.record_id
      WHERE ref.workspace_id = ? AND NOT EXISTS (
        SELECT 1 FROM projection_erase_barriers AS barrier
        WHERE barrier.workspace_id = source.workspace_id
          AND barrier.subject_kind = 'source_record'
          AND barrier.subject_id = source.record_id
      )
    `).all(workspaceId) as readonly { evidence_object_id: string }[];
    return new Set(rows.map((entry) => entry.evidence_object_id));
  }
}

const CLAIM_FACT_SELECT = `
  SELECT object_id, claim_status, json_extract(governance_subject, '$.canonical_key') AS canonical_key,
         scope_class, created_at, updated_at, evidence_refs
  FROM claim_forms
`;

interface ClaimFactRow {
  readonly object_id: string;
  readonly claim_status: string;
  readonly canonical_key: string;
  readonly scope_class: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly evidence_refs: string;
}

interface MemoryFactRow {
  readonly object_id: string;
  readonly lifecycle_state: string;
  readonly scope_class: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly content: string;
  readonly evidence_refs: string;
}

function toClaimFact(
  claim: ClaimFactRow,
  grounded: ReadonlySet<string>,
  targetScope: string
): string {
  const evidenceRefs = JSON.parse(claim.evidence_refs) as unknown;
  if (!Array.isArray(evidenceRefs) || evidenceRefs.some((id) => typeof id !== "string")) {
    throw new StorageError("VALIDATION_FAILED", "claim evidence refs are invalid");
  }
  return canonicalEffectClaimFact({
    ...claim,
    has_evidence: evidenceRefs.some((id) => grounded.has(id)),
    scope_compatible: claim.scope_class === targetScope
  });
}

function toMemoryFact(memory: MemoryFactRow, sha256: FieldContractSha256): string {
  const evidenceRefs = JSON.parse(memory.evidence_refs) as unknown;
  if (!Array.isArray(evidenceRefs) || evidenceRefs.some((id) => typeof id !== "string")) {
    throw new StorageError("VALIDATION_FAILED", "memory evidence refs are invalid");
  }
  return canonicalEffectMemoryFact({
    ...memory,
    content_digest: hashContentDigest(memory.content, sha256),
    evidence_refs: evidenceRefs
  });
}

function prepareEffectStatements(database: StorageDatabase) {
  return {
    insertStatement: database.connection.prepare(`
      INSERT INTO proof_effect_decisions (
        schema_version, request_digest, workspace_id, actor_id, run_id, delivery_id,
        action, target, scope, effective_as_of, decision,
        supporting_receipt_ids_json, supporting_proof_witnesses_json,
        governance_frontier, policy_operator_id, policy_operator_version, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, request_digest) DO NOTHING
    `),
    selectStatement: database.connection.prepare(`
      SELECT schema_version, request_digest, workspace_id, actor_id, run_id, delivery_id,
             action, target, scope, effective_as_of, decision,
             supporting_receipt_ids_json, supporting_proof_witnesses_json,
             governance_frontier, policy_operator_id, policy_operator_version, recorded_at
      FROM proof_effect_decisions WHERE workspace_id = ? AND request_digest = ? LIMIT 1
    `),
    sourceWitnessStatement: database.connection.prepare(`
      SELECT 1 FROM source_records AS source
      WHERE source.workspace_id = ? AND source.record_id = ?
        AND source.content_digest = ?
        AND NOT EXISTS (
          SELECT 1 FROM projection_erase_barriers AS barrier
          WHERE barrier.workspace_id = source.workspace_id
            AND barrier.subject_kind = 'source_record'
            AND barrier.subject_id = source.record_id
        )
      LIMIT 1
    `)
  };
}

function sameEffectDecision(existing: FieldProofEffectRow, row: FieldProofEffectRow): boolean {
  return existing.actor_id === row.actor_id && existing.run_id === row.run_id &&
    existing.delivery_id === row.delivery_id && existing.action === row.action &&
    existing.target === row.target && existing.scope === row.scope &&
    existing.effective_as_of === row.effective_as_of && existing.decision === row.decision &&
    existing.supporting_receipt_ids_json === row.supporting_receipt_ids_json &&
    existing.supporting_proof_witnesses_json === row.supporting_proof_witnesses_json &&
    existing.governance_frontier === row.governance_frontier &&
    existing.policy_operator_id === row.policy_operator_id &&
    existing.policy_operator_version === row.policy_operator_version;
}

function assertWitnessSet(json: string, witnesses: readonly ProofEffectWitness[]): void {
  const receiptIds = JSON.parse(json) as unknown;
  if (!Array.isArray(receiptIds) || receiptIds.some((id) => typeof id !== "string") ||
      receiptIds.length !== witnesses.length ||
      receiptIds.some((id) => !witnesses.some((witness) => witness.receipt_id === id))) {
    throw new StorageError("VALIDATION_FAILED", "proof effect witness set mismatch");
  }
}

function parseProofWitnesses(json: string): readonly ProofEffectWitness[] {
  const parsed: unknown = JSON.parse(json);
  return ProofEffectWitnessSchema.array().parse(parsed);
}

function hasSourceWitness(witness: ProofEffectWitness): witness is ProofEffectWitness & {
  readonly source_record_id: string;
  readonly source_content_digest: string;
} {
  if (witness.kind !== "source_grounding") return false;
  if (witness.source_record_id === null || witness.source_content_digest === null) {
    throw new StorageError("VALIDATION_FAILED", "source proof lacks a durable witness");
  }
  return true;
}
