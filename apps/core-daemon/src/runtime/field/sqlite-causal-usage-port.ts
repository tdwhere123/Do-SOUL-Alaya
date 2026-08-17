import {
  CAUSAL_USAGE_OPERATOR_ID,
  CausalUsageReceiptSchema,
  verifyCausalUsageReceipt,
  type CausalUsagePort,
  type CausalUsageReceipt,
  type FieldContractSha256
} from "@do-soul/alaya-protocol";
import type { FieldCausalUsageRepo, FieldCausalUsageRow } from "@do-soul/alaya-storage";

export function createSqliteCausalUsagePort(input: Readonly<{
  readonly repo: FieldCausalUsageRepo;
  readonly sha256: FieldContractSha256;
}>): CausalUsagePort {
  return {
    recordUsage(receipt) {
      const verified = verifyCausalUsageReceipt(receipt, input.sha256);
      const result = input.repo.insert(usageToRow(verified));
      return Object.freeze({
        receipt: causalUsageReceiptFromRow(result.row, input.sha256),
        inserted: result.inserted
      });
    }
  };
}

function usageToRow(receipt: CausalUsageReceipt): FieldCausalUsageRow {
  return {
    identity: receipt.identity,
    workspace_id: receipt.workspace_id,
    causal_key: receipt.causal_key,
    occurred_at: receipt.occurred_at,
    downstream_ref: receipt.downstream_ref,
    weight: receipt.weight,
    scope: receipt.scope,
    usage_kind: receipt.usage_kind,
    operator_id: receipt.operator_id,
    recorded_at: receipt.recorded_at
  };
}

export function causalUsageReceiptFromRow(
  row: FieldCausalUsageRow,
  sha256: FieldContractSha256
): CausalUsageReceipt {
  return verifyCausalUsageReceipt(CausalUsageReceiptSchema.parse({
    schema_version: 1,
    producer: CAUSAL_USAGE_OPERATOR_ID,
    consumer: "path_projection",
    replay_rule: "idempotent_same_identity",
    failure_disposition: "fail_closed",
    governance_effect: "none",
    deletion_behavior: "retain_identity",
    identity: row.identity,
    workspace_id: row.workspace_id,
    causal_key: row.causal_key,
    occurred_at: row.occurred_at,
    downstream_ref: row.downstream_ref,
    weight: row.weight,
    scope: row.scope,
    usage_kind: row.usage_kind,
    operator_id: row.operator_id,
    recorded_at: row.recorded_at
  }), sha256);
}
