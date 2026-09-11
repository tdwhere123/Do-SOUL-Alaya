import { randomUUID } from "node:crypto";
import { InformationIndexSchema } from "@do-soul/alaya-protocol";
import type { ConditionalFieldRecallPortResult, runConditionalFieldRecallWithReceipt } from "@do-soul/alaya-core";
import type { RecallReadWorkerRuntime } from "./runtime.js";

type Execution = ReturnType<typeof runConditionalFieldRecallWithReceipt>;
type Prepared = { issue?: Execution["issue"]; receipt: Execution["execution_receipt"]; metadata: NonNullable<ConditionalFieldRecallPortResult["source_metadata"]> };
const PREPARED = new WeakMap<RecallReadWorkerRuntime, Map<string, Prepared>>();

export function prepareWorkerDelivery(
  runtime: RecallReadWorkerRuntime,
  execution: Execution,
  metadata: Prepared["metadata"]
): string {
  let pending = PREPARED.get(runtime);
  if (pending === undefined) { pending = new Map(); PREPARED.set(runtime, pending); }
  const id = randomUUID();
  pending.set(id, { issue: execution.issue, receipt: execution.execution_receipt, metadata });
  while (pending.size > 32) pending.delete(pending.keys().next().value!);
  return id;
}

export function settleWorkerDelivery(
  runtime: RecallReadWorkerRuntime,
  payload: Record<string, unknown>,
  discard: boolean
): Execution["execution_receipt"] | null {
  const pending = PREPARED.get(runtime);
  const id = payload.preparation_id;
  if (typeof id !== "string") throw new TypeError("Recall preparation id required");
  if (discard) { pending?.delete(id); return null; }
  const prepared = pending?.get(id);
  if (prepared === undefined) throw new Error("Recall preparation expired or discarded");
  if (prepared.issue === undefined) return prepared.receipt;
  const index = InformationIndexSchema.parse(payload.index);
  const entries = Object.entries(payload.previews as Record<string, unknown>);
  if (entries.some(([, value]) => typeof value !== "string")) throw new TypeError("invalid Recall previews");
  prepared.issue({ index, previews: new Map(entries as [string, string][]), metadata: prepared.metadata });
  // An acknowledgment retry must neither retain source closures nor advance a successor.
  pending!.set(id, { metadata: {}, receipt: prepared.receipt });
  return prepared.receipt;
}
