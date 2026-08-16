import type { StorageDatabase } from "../../sqlite/db.js";
import { parseOptionalRow } from "../shared/parse-row.js";
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

  public constructor(database: StorageDatabase) {
    this.insertStatement = database.connection.prepare(`
      INSERT INTO causal_usage_receipts (
        receipt_id, workspace_id, causal_key, occurred_at, downstream_ref,
        weight, scope, usage_kind
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(receipt_id) DO NOTHING
    `);
    this.selectStatement = database.connection.prepare(`
      SELECT receipt_id, workspace_id, causal_key, occurred_at, downstream_ref,
             weight, scope, usage_kind
      FROM causal_usage_receipts WHERE receipt_id = ? LIMIT 1
    `);
  }

  public insert(row: FieldCausalUsageRow): FieldCausalUsageRow {
    return insertIdempotent(
      () => this.insertStatement.run(
        row.receipt_id, row.workspace_id, row.causal_key, row.occurred_at,
        row.downstream_ref, row.weight, row.scope, row.usage_kind
      ),
      () => this.findById(row.receipt_id),
      (existing) => existing.workspace_id === row.workspace_id &&
        existing.causal_key === row.causal_key &&
        existing.occurred_at === row.occurred_at &&
        existing.downstream_ref === row.downstream_ref &&
        existing.weight === row.weight &&
        existing.scope === row.scope &&
        existing.usage_kind === row.usage_kind,
      "causal usage receipt"
    );
  }

  public findById(receiptId: string): FieldCausalUsageRow | null {
    return parseOptionalRow(
      this.selectStatement.get(receiptId),
      fieldCausalUsageParser,
      "causal usage receipt"
    );
  }
}

export class SqliteFieldProofEffectRepo implements FieldProofEffectRepo {
  private readonly insertStatement;
  private readonly selectStatement;

  public constructor(database: StorageDatabase) {
    this.insertStatement = database.connection.prepare(`
      INSERT INTO proof_effect_decisions (
        request_digest, action, target, scope, effective_as_of, decision,
        supporting_receipt_ids_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(request_digest) DO NOTHING
    `);
    this.selectStatement = database.connection.prepare(`
      SELECT request_digest, action, target, scope, effective_as_of, decision,
             supporting_receipt_ids_json
      FROM proof_effect_decisions WHERE request_digest = ? LIMIT 1
    `);
  }

  public insert(row: FieldProofEffectRow): FieldProofEffectRow {
    return insertIdempotent(
      () => this.insertStatement.run(
        row.request_digest, row.action, row.target, row.scope,
        row.effective_as_of, row.decision, row.supporting_receipt_ids_json
      ),
      () => this.findById(row.request_digest),
      (existing) => existing.action === row.action &&
        existing.target === row.target &&
        existing.scope === row.scope &&
        existing.effective_as_of === row.effective_as_of &&
        existing.decision === row.decision &&
        existing.supporting_receipt_ids_json === row.supporting_receipt_ids_json,
      "proof effect decision"
    );
  }

  public findById(requestDigest: string): FieldProofEffectRow | null {
    return parseOptionalRow(
      this.selectStatement.get(requestDigest),
      fieldProofEffectParser,
      "proof effect decision"
    );
  }
}
