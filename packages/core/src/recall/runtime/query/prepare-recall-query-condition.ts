import type {
  FieldContractSha256,
  OpenSemanticFactorFormationCapture,
  ProjectionPin,
  QueryConditionReceipt
} from "@do-soul/alaya-protocol";
import {
  captureEffectiveAsOf,
  captureQueryCondition
} from "../../query/condition/query-condition-capture.js";
import type { RecallRequestTimeContext } from "./recall-request-time.js";

export type PrepareRecallQueryConditionInput = Readonly<{
  readonly workspaceId: string;
  readonly explicitAsOf?: string;
  readonly queryText: string | null;
  readonly tokenBudget: number;
  readonly activationBudget: number;
  readonly sha256: FieldContractSha256;
  readonly time: RecallRequestTimeContext;
  readonly pin: Readonly<Pick<ProjectionPin, "workspace_id" | "generation_id">>;
  readonly principal?: string;
  readonly semanticCapture?: Readonly<OpenSemanticFactorFormationCapture>;
}>;

export type PreparedQueryConditionCapture = Readonly<{
  readonly receipt: QueryConditionReceipt;
  readonly referenceTime: string;
  readonly pin: ProjectionPin;
}>;

export function capturePreparedRequestCondition(input: Readonly<{
  readonly workspaceId: string;
  readonly explicitAsOf?: string;
  readonly queryText: string | null;
  readonly tokenBudget: number;
  readonly activationBudget: number;
  readonly sha256: FieldContractSha256;
  readonly time: RecallRequestTimeContext;
  readonly session: {
    pinActiveGeneration(workspaceId: string, recordedAt: string): ProjectionPin;
    release(pin: ProjectionPin, releasedAt: string): ProjectionPin;
  };
  readonly principal?: string;
  readonly semanticCapture?: Readonly<OpenSemanticFactorFormationCapture>;
}>): PreparedQueryConditionCapture {
  const referenceTime = input.time.effectiveAsOf;
  const pin = input.session.pinActiveGeneration(input.workspaceId, input.time.capturedAt);
  try {
    return {
      referenceTime,
      pin,
      receipt: prepareRecallQueryCondition({
        ...input,
        explicitAsOf: referenceTime,
        pin
      })
    };
  } catch (error) {
    input.session.release(pin, input.time.capturedAt);
    throw error;
  }
}

export function prepareRecallQueryCondition(
  input: PrepareRecallQueryConditionInput
): QueryConditionReceipt {
  const effectiveAsOf = captureEffectiveAsOf(
    input.explicitAsOf,
    () => input.time.effectiveAsOf
  );
  return captureQueryCondition({
    principal: input.principal ?? input.workspaceId,
    workspace_id: input.workspaceId,
    authorized_scopes: [input.workspaceId],
    explicit_bridges: [],
    workspace_project: input.workspaceId,
    effective_as_of: effectiveAsOf,
    query_task_factors: queryTaskFactors(input.queryText, input.semanticCapture),
    governance_state: "open",
    activation_budget: input.activationBudget,
    token_budget: input.tokenBudget
  }, {
    sha256: input.sha256,
    now: () => input.time.effectiveAsOf,
    recordedAt: input.time.capturedAt,
    pin: input.pin
  });
}

function queryTaskFactors(
  queryText: string | null,
  capture: Readonly<OpenSemanticFactorFormationCapture> | undefined
): readonly string[] {
  const factors = queryText === null || queryText.length === 0 ? [] : [queryText];
  if (capture?.status !== "formed" || capture.graph === null) {
    return Object.freeze(factors);
  }
  const present = new Set(factors);
  for (const factor of capture.graph.factors) {
    if (present.has(factor.semantic_identity)) continue;
    present.add(factor.semantic_identity);
    factors.push(factor.semantic_identity);
  }
  return Object.freeze(factors);
}
