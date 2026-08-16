import {
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
      const row = input.repo.insert(usageToRow(verified));
      return usageFromRow(row, verified);
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

function usageFromRow(
  row: FieldCausalUsageRow,
  receipt: CausalUsageReceipt
): CausalUsageReceipt {
  return {
    ...receipt,
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
  };
}
