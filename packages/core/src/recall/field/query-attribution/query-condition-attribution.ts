import type {
  QueryConditionReceipt
} from "@do-soul/alaya-protocol";
import type {
  RecallQueryFieldAttribution,
  RecallQueryFieldRole
} from "./query-field-attribution.js";

export type SoftConditionFactorRole = RecallQueryFieldRole | "task";

export type SoftConditionFactor = Readonly<{
  readonly factor_id: string;
  readonly role: SoftConditionFactorRole;
  readonly weight: number;
}>;

export function assertTransientQueryCondition(
  receipt: QueryConditionReceipt
): void {
  if (receipt.governance_effect !== "none") {
    throw new Error("query conditions cannot become learning receipts");
  }
  if (receipt.deletion_behavior !== "rebuildable") {
    throw new Error("query conditions must remain rebuildable");
  }
}

export function projectSoftConditionFactors(input: Readonly<{
  readonly receipt: QueryConditionReceipt;
  readonly attributions?: readonly Readonly<RecallQueryFieldAttribution>[];
}>): readonly SoftConditionFactor[] {
  assertTransientQueryCondition(input.receipt);
  const factors = [
    ...input.receipt.condition.query_task_factors.map((factor_id) =>
      factor(factor_id, "task")
    ),
    ...(input.attributions ?? []).map((attribution) =>
      factor(attribution.query_atom_id, attribution.role)
    )
  ];
  return Object.freeze(uniqueFactors(factors));
}

function factor(
  factor_id: string,
  role: SoftConditionFactorRole
): SoftConditionFactor {
  return Object.freeze({ factor_id, role, weight: 1 });
}

function uniqueFactors(
  factors: readonly SoftConditionFactor[]
): readonly SoftConditionFactor[] {
  const seen = new Set<string>();
  const output: SoftConditionFactor[] = [];
  for (const item of factors) {
    const key = `${item.role}:${item.factor_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output.sort((left, right) =>
    left.factor_id === right.factor_id
      ? compareText(left.role, right.role)
      : compareText(left.factor_id, right.factor_id)
  );
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}
