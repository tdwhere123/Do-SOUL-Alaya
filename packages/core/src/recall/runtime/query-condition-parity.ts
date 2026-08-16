import type { QueryConditionReceipt } from "@do-soul/alaya-protocol";

export type QueryConditionParityView = Readonly<{
  readonly effective_as_of: string;
  readonly condition_digest: string;
  readonly query_cache_key: string;
  readonly generation_id: string;
}>;

export function queryConditionParityView(
  receipt: QueryConditionReceipt
): QueryConditionParityView {
  return Object.freeze({
    effective_as_of: receipt.condition.effective_as_of,
    condition_digest: receipt.identity,
    query_cache_key: receipt.query_cache_key,
    generation_id: receipt.generation_id
  });
}

export function compareQueryConditionParity(
  direct: QueryConditionReceipt,
  worker: QueryConditionReceipt
): boolean {
  const left = queryConditionParityView(direct);
  const right = queryConditionParityView(worker);
  return left.effective_as_of === right.effective_as_of &&
    left.condition_digest === right.condition_digest &&
    left.query_cache_key === right.query_cache_key &&
    left.generation_id === right.generation_id;
}
