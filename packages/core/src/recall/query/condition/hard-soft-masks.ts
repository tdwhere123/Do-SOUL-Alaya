import {
  classifyFieldValidTime,
  type QueryCondition
} from "@do-soul/alaya-protocol";
import type { ActivationNode } from
  "../../flood/activation/activation-graph.js";
import { assertDissipativeLambda } from
  "../../scoring/activation/dissipative-transfer.js";

export type HardMaskInput = Readonly<{
  readonly workspace_id: string;
  readonly authorized_scopes: readonly string[];
  readonly explicit_bridges: readonly string[];
  readonly generation_id: string;
  readonly effective_as_of: string;
}>;

export type SoftConditionAdjustment = Readonly<{
  readonly lambda: number;
  readonly hop_cost: number;
}>;

const UNMATCHED_TASK_LAMBDA_SCALE = 0.9;

export function evaluateHardMask(
  node: Readonly<ActivationNode>,
  input: HardMaskInput
): "allow" | "deny" {
  if (node.workspace_id !== input.workspace_id) return "deny";
  if (node.generation_id !== input.generation_id) return "deny";
  if (node.sealed || node.erased || node.revoked) return "deny";
  if (!scopeAuthorized(node, input)) return "deny";
  if (classifyFieldValidTime(node, input.effective_as_of) === "inactive") return "deny";
  return "allow";
}

export function applySoftConditionFactors(input: Readonly<{
  readonly lambda: number;
  readonly hop_cost: number;
  readonly node: Readonly<ActivationNode>;
  readonly condition: QueryCondition;
}>): SoftConditionAdjustment {
  const matched = input.node.task_factor_id !== null &&
    input.condition.query_task_factors.includes(input.node.task_factor_id);
  const lambda = assertDissipativeLambda(
    matched ? input.lambda : input.lambda * UNMATCHED_TASK_LAMBDA_SCALE
  );
  return Object.freeze({ lambda, hop_cost: input.hop_cost });
}

export function seedActivationEnergy(
  node: Readonly<ActivationNode>,
  asOf: string
): number {
  return classifyFieldValidTime(node, asOf) === "soft_recallable" ? 0.5 : 1;
}

function scopeAuthorized(
  node: Readonly<ActivationNode>,
  input: HardMaskInput
): boolean {
  if (input.authorized_scopes.includes(node.scope)) return true;
  return node.adopted_bridge !== null &&
    input.explicit_bridges.includes(node.adopted_bridge);
}
