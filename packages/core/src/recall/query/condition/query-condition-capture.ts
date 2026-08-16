import {
  hashConditionDigest,
  hashQueryCacheKey,
  IsoDatetimeStringSchema,
  QUERY_CONDITION_OPERATOR_ID,
  QueryConditionReceiptSchema,
  QueryConditionSchema,
  verifyQueryConditionReceipt,
  type FieldContractSha256,
  type ProjectionPin,
  type QueryCondition,
  type QueryConditionPort,
  type QueryConditionReceipt
} from "@do-soul/alaya-protocol";

export type QueryConditionDraft = Omit<QueryCondition, "effective_as_of"> & {
  readonly effective_as_of?: string;
};

export type QueryConditionCaptureDeps = Readonly<{
  readonly sha256: FieldContractSha256;
  readonly now: () => string;
  readonly pin: Readonly<Pick<ProjectionPin, "workspace_id" | "generation_id">>;
}>;

export function captureEffectiveAsOf(
  explicit: string | undefined,
  now: () => string
): string {
  const value = explicit === undefined ? now() : explicit;
  return IsoDatetimeStringSchema.parse(value);
}

export function materializeQueryCondition(
  draft: QueryConditionDraft,
  now: () => string
): QueryCondition {
  return QueryConditionSchema.parse({
    ...draft,
    effective_as_of: captureEffectiveAsOf(draft.effective_as_of, now)
  });
}

export function createQueryConditionPort(
  deps: QueryConditionCaptureDeps
): QueryConditionPort {
  return {
    captureCondition: (input) => captureResolvedCondition(input, deps)
  };
}

export function captureQueryCondition(
  draft: QueryConditionDraft,
  deps: QueryConditionCaptureDeps
): QueryConditionReceipt {
  return captureResolvedCondition(materializeQueryCondition(draft, deps.now), deps);
}

function captureResolvedCondition(
  input: QueryCondition,
  deps: QueryConditionCaptureDeps
): QueryConditionReceipt {
  const condition = QueryConditionSchema.parse(input);
  assertPinnedWorkspace(deps.pin, condition);
  const identity = hashConditionDigest(condition, deps.sha256);
  const receipt = QueryConditionReceiptSchema.parse({
    schema_version: 1,
    producer: QUERY_CONDITION_OPERATOR_ID,
    consumer: "attributed_activation",
    identity,
    replay_rule: "idempotent_same_identity",
    failure_disposition: "fail_closed",
    governance_effect: "none",
    deletion_behavior: "rebuildable",
    condition,
    generation_id: deps.pin.generation_id,
    query_operator_id: QUERY_CONDITION_OPERATOR_ID,
    query_cache_key: hashQueryCacheKey({
      generation_id: deps.pin.generation_id,
      condition_digest: identity,
      query_operator_id: QUERY_CONDITION_OPERATOR_ID
    }, deps.sha256),
    // Same captured instant as C_q; a second clock read would fork as-of from the receipt.
    recorded_at: condition.effective_as_of
  });
  return verifyQueryConditionReceipt(receipt, deps.sha256);
}

function assertPinnedWorkspace(
  pin: QueryConditionCaptureDeps["pin"],
  condition: QueryCondition
): void {
  if (pin.workspace_id !== condition.workspace_id) {
    throw new Error("query condition workspace does not match the pinned generation");
  }
}
