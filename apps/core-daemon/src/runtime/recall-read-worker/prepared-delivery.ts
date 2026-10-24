import { randomUUID } from "node:crypto";
import { indexEntryCacheKey, type InformationIndex } from "@do-soul/alaya-protocol";
import { CoreError, type ConditionalFieldRecallPortResult, type runConditionalFieldRecallWithReceipt } from "@do-soul/alaya-core";
import type { WorkerOperationPayload } from "./operation-schemas.js";
import { attachMeasuredWorkerCost, measuredWorkerCostOfReceipt } from "../recall/worker-actual-cost.js";
import { claimDeliverySettlement, finishDeliverySettlement } from "./delivery-settlement.js";
import type { RecallReadWorkerRuntime } from "./runtime.js";

type Execution = ReturnType<typeof runConditionalFieldRecallWithReceipt>;
type Prepared = {
  issue?: Execution["issue"];
  receipt: Execution["execution_receipt"];
  metadata: NonNullable<ConditionalFieldRecallPortResult["source_metadata"]>;
  index: InformationIndex;
};
const PREPARED = new WeakMap<RecallReadWorkerRuntime, Map<string, Prepared>>();

export function prepareWorkerDelivery(
  runtime: RecallReadWorkerRuntime,
  execution: Execution,
  metadata: Prepared["metadata"]
): string {
  let pending = PREPARED.get(runtime);
  if (pending === undefined) { pending = new Map(); PREPARED.set(runtime, pending); }
  const id = randomUUID();
  pending.set(id, { issue: execution.issue, receipt: execution.execution_receipt, metadata, index: execution.index });
  while (pending.size > 32) pending.delete(pending.keys().next().value!);
  return id;
}

export function settleWorkerDelivery(
  runtime: RecallReadWorkerRuntime,
  payload: WorkerOperationPayload<"conditionalField.acknowledge"> | WorkerOperationPayload<"conditionalField.discard">,
  discard: boolean
): Execution["execution_receipt"] | null {
  const pending = PREPARED.get(runtime);
  const id = payload.preparation_id;
  if (discard) { pending?.delete(id); return null; }
  const prepared = pending?.get(id);
  if (prepared === undefined) throw new Error("Recall preparation expired or discarded");
  try {
    return settlePrepared(pending!, id, prepared,
      payload as WorkerOperationPayload<"conditionalField.acknowledge">);
  } catch (error) {
    // issue() refreshes this same receipt even on refusal (including its pin read).
    const measured = measuredWorkerCostOfReceipt(prepared.receipt);
    if (measured !== undefined) attachMeasuredWorkerCost(error, measured);
    throw error;
  }
}

function settlePrepared(pending: Map<string, Prepared>, id: string, prepared: Prepared,
  acknowledgePayload: WorkerOperationPayload<"conditionalField.acknowledge">): Execution["execution_receipt"] | null {
  // A retried or first acknowledgement must describe the same prepared membership;
  // a re-issued envelope may never substitute entries after the fact.
  const issuedIds = acknowledgePayload.issued_entry_ids;
  const expected = prepared.index.entries.map(indexEntryCacheKey);
  if (issuedIds.length !== expected.length
    || issuedIds.some((entryId, offset) => entryId !== expected[offset])) {
    throw new Error("Recall envelope changed prepared membership");
  }
  if (prepared.issue === undefined) {
    // A cancelled retry cannot undo an already acknowledged exposure.
    finishDeliverySettlement(acknowledgePayload.settlement, true);
    return prepared.receipt;
  }
  const entries = Object.entries(acknowledgePayload.previews);
  if (entries.some(([, value]) => typeof value !== "string")) throw new TypeError("invalid Recall previews");
  if (!claimDeliverySettlement(acknowledgePayload.settlement)) {
    pending.delete(id);
    throw new CoreError("CONFLICT", "Recall acknowledgment cancelled before issuance", {
      details: { delivery_settlement: "cancelled", execution_receipt: prepared.receipt }
    });
  }
  try {
    prepared.issue({ index: prepared.index, previews: new Map(entries), metadata: prepared.metadata });
    finishDeliverySettlement(acknowledgePayload.settlement, true);
  } catch (error) {
    finishDeliverySettlement(acknowledgePayload.settlement, false);
    throw error;
  }
  // An acknowledgment retry must neither retain source closures nor advance a successor.
  pending.set(id, { metadata: {}, receipt: prepared.receipt, index: prepared.index });
  return prepared.receipt;
}
