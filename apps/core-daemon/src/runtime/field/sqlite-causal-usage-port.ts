import {
  FieldGenerationEventType,
  SoulFieldUsageCausalRecordedPayloadSchema,
  verifyCausalUsageReceipt,
  type CausalUsagePort,
  type CausalUsageReceipt,
  type EventLogEntry,
  type FieldContractSha256
} from "@do-soul/alaya-protocol";
import type { FieldCausalUsageRepo, FieldCausalUsageRow } from "@do-soul/alaya-storage";

export function createSqliteCausalUsagePort(input: Readonly<{
  readonly repo: FieldCausalUsageRepo;
  readonly sha256: FieldContractSha256;
  readonly eventLog: {
    append(event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">):
      EventLogEntry | Promise<EventLogEntry>;
  };
}>): CausalUsagePort {
  return {
    recordUsage(receipt) {
      const verified = verifyCausalUsageReceipt(receipt, input.sha256);
      const existing = input.repo.findById(verified.workspace_id, verified.identity);
      const row = input.repo.insert(usageToRow(verified));
      if (existing === null) {
        appendUsageEvent(input.eventLog, verified);
      }
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

function appendUsageEvent(
  eventLog: {
    append(event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">):
      EventLogEntry | Promise<EventLogEntry>;
  },
  receipt: CausalUsageReceipt
): void {
  void eventLog.append({
    event_type: FieldGenerationEventType.SOUL_FIELD_USAGE_CAUSAL_RECORDED,
    entity_type: "causal_usage",
    entity_id: receipt.identity,
    workspace_id: receipt.workspace_id,
    run_id: null,
    caused_by: "system",
    payload_json: SoulFieldUsageCausalRecordedPayloadSchema.parse({
      workspace_id: receipt.workspace_id,
      identity: receipt.identity,
      causal_key: receipt.causal_key,
      occurred_at: receipt.occurred_at,
      downstream_ref: receipt.downstream_ref,
      weight: receipt.weight,
      scope: receipt.scope,
      usage_kind: "causal",
      operator_id: receipt.operator_id
    })
  });
}
