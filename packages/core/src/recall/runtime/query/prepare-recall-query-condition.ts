import type {
  FieldContractSha256,
  ProjectionPin,
  QueryConditionReceipt
} from "@do-soul/alaya-protocol";
import {
  captureEffectiveAsOf,
  captureQueryCondition
} from "../../query/condition/query-condition-capture.js";

export type PrepareRecallQueryConditionInput = Readonly<{
  readonly workspaceId: string;
  readonly explicitAsOf?: string;
  readonly queryText: string | null;
  readonly tokenBudget: number;
  readonly activationBudget: number;
  readonly sha256: FieldContractSha256;
  readonly now: () => string;
  readonly pin: Readonly<Pick<ProjectionPin, "workspace_id" | "generation_id">>;
  readonly principal?: string;
}>;

export type PreparedQueryConditionCapture = Readonly<{
  readonly receipt: QueryConditionReceipt;
  readonly referenceTime: string;
}>;

export function resolvePreparedAsOf(
  explicit: string | undefined,
  now: () => string
): string {
  if (explicit === undefined) return captureEffectiveAsOf(undefined, now);
  if (!/(?:z|[+-]\d{2}:\d{2})$/iu.test(explicit)) {
    throw new Error("recall reference time must include a timezone offset");
  }
  if (!Number.isFinite(Date.parse(explicit))) {
    throw new Error("recall reference time must be a valid date-time");
  }
  return explicit;
}

export function toConditionAsOf(value: string): string {
  try {
    return captureEffectiveAsOf(value, () => value);
  } catch {
    return new Date(value).toISOString();
  }
}

export function capturePreparedRequestCondition(input: Readonly<{
  readonly workspaceId: string;
  readonly explicitAsOf?: string;
  readonly queryText: string | null;
  readonly tokenBudget: number;
  readonly activationBudget: number;
  readonly sha256: FieldContractSha256;
  readonly now: () => string;
  readonly session: {
    pinActiveGeneration(workspaceId: string, recordedAt: string): Readonly<
      Pick<ProjectionPin, "workspace_id" | "generation_id">
    >;
  };
  readonly principal?: string;
}>): PreparedQueryConditionCapture {
  const referenceTime = resolvePreparedAsOf(input.explicitAsOf, input.now);
  const conditionAsOf = toConditionAsOf(referenceTime);
  return {
    referenceTime,
    receipt: prepareRecallQueryCondition({
      ...input,
      explicitAsOf: conditionAsOf,
      pin: input.session.pinActiveGeneration(input.workspaceId, conditionAsOf)
    })
  };
}

export function prepareRecallQueryCondition(
  input: PrepareRecallQueryConditionInput
): QueryConditionReceipt {
  const effectiveAsOf = toConditionAsOf(resolvePreparedAsOf(input.explicitAsOf, input.now));
  return captureQueryCondition({
    principal: input.principal ?? input.workspaceId,
    workspace_id: input.workspaceId,
    authorized_scopes: [input.workspaceId],
    explicit_bridges: [],
    workspace_project: input.workspaceId,
    effective_as_of: effectiveAsOf,
    query_task_factors: queryTaskFactors(input.queryText),
    governance_state: "open",
    activation_budget: input.activationBudget,
    token_budget: input.tokenBudget
  }, {
    sha256: input.sha256,
    now: input.now,
    pin: input.pin
  });
}

function queryTaskFactors(queryText: string | null): readonly string[] {
  if (queryText === null || queryText.length === 0) return [];
  return [queryText];
}
