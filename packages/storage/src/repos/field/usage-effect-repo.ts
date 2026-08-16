import type { FieldContractSha256 } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
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
  }

  public insert(row: FieldCausalUsageRow): FieldCausalUsageRow {
    verifyPersistedUsage(row, this.sha256);
    return insertIdempotent(
      () => this.insertStatement.run(
        row.identity, row.workspace_id, row.causal_key, row.occurred_at,
        row.downstream_ref, row.weight, row.scope, row.usage_kind,
        row.operator_id, row.recorded_at
      ),
      () => this.findById(row.workspace_id, row.identity),
      (existing) => existing.causal_key === row.causal_key &&
        existing.occurred_at === row.occurred_at &&
        existing.downstream_ref === row.downstream_ref &&
        existing.weight === row.weight &&
        existing.scope === row.scope &&
        existing.usage_kind === row.usage_kind &&
        existing.operator_id === row.operator_id,
      "causal usage receipt"
    );
  }

  public findById(workspaceId: string, identity: string): FieldCausalUsageRow | null {
    return parseOptionalRow(
      this.selectStatement.get(workspaceId, identity),
      fieldCausalUsageParser,
      "causal usage receipt"
    );
  }
}

export class SqliteFieldProofEffectRepo implements FieldProofEffectRepo {
  private readonly insertStatement;
  private readonly selectStatement;

  public constructor(
    database: StorageDatabase,
    private readonly sha256: FieldContractSha256
  ) {
    this.insertStatement = database.connection.prepare(`
      INSERT INTO proof_effect_decisions (
        request_digest, workspace_id, action, target, scope, effective_as_of,
        decision, supporting_receipt_ids_json, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, request_digest) DO NOTHING
    `);
    this.selectStatement = database.connection.prepare(`
      SELECT request_digest, workspace_id, action, target, scope, effective_as_of,
             decision, supporting_receipt_ids_json, recorded_at
      FROM proof_effect_decisions WHERE workspace_id = ? AND request_digest = ? LIMIT 1
    `);
  }

  public insert(row: FieldProofEffectRow): FieldProofEffectRow {
    verifyPersistedEffect(row, this.sha256);
    return insertIdempotent(
      () => this.insertStatement.run(
        row.request_digest, row.workspace_id, row.action, row.target, row.scope,
        row.effective_as_of, row.decision, row.supporting_receipt_ids_json, row.recorded_at
      ),
      () => this.findById(row.workspace_id, row.request_digest),
      (existing) => existing.action === row.action &&
        existing.target === row.target &&
        existing.scope === row.scope &&
        existing.effective_as_of === row.effective_as_of &&
        existing.decision === row.decision &&
        existing.supporting_receipt_ids_json === row.supporting_receipt_ids_json,
      "proof effect decision"
    );
  }

  public findById(workspaceId: string, requestDigest: string): FieldProofEffectRow | null {
    return parseOptionalRow(
      this.selectStatement.get(workspaceId, requestDigest),
      fieldProofEffectParser,
      "proof effect decision"
    );
  }
}
