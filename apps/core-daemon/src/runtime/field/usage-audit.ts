import {
  FieldGenerationEventType,
  SoulFieldUsageCausalRecordedPayloadSchema,
  type CausalUsageReceipt
} from "@do-soul/alaya-protocol";
import type { FieldEventLogPort } from "./generation-audit.js";

export function appendCausalUsageRecorded(
  eventLog: FieldEventLogPort,
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
