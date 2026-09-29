import {
  SourceSemanticResourceLedger, SourceSemanticResourceExhausted,
  type RequestBudget, type SourceSemanticAttention
} from "@do-soul/alaya-protocol";
import type { FieldEngineState } from "../conditional-field/engine/field-engine.js";
import type { admitSourceSemanticCorrespondence } from "../conditional-field/query/source-semantic-correspondence-admission.js";
import type { SourceSemanticExecutionPlan, SourceSemanticGroupPhase } from "../conditional-field/query/compile-source-semantic-finite.js";
import {
  mergeComputedAttention, sourceSemanticBranchAttention, unexecutedGroupAttention
} from "./source-semantic-attention.js";
import type { SourceSemanticResultBody } from "./source-semantic-projection.js";

type Admission = Extract<ReturnType<typeof admitSourceSemanticCorrespondence>, { kind: "admitted" }>;
export type OptionalAttentionCompute = (child: SourceSemanticResourceLedger) => SourceSemanticAttention | undefined;
export type OptionalAttentionBudget = Pick<RequestBudget, "finalization_reserve" | "min_envelope">;
export type OptionalAttentionPhase = Readonly<{
  state: FieldEngineState; execution: SourceSemanticExecutionPlan; acceptedBranchIndices: ReadonlySet<number>;
}>;

/** Child allowance leaves the parent's remaining finalization reserve and min envelope untouched. */
export function runOptionalAttention(
  parent: SourceSemanticResourceLedger, budget: OptionalAttentionBudget, compute: OptionalAttentionCompute
): SourceSemanticAttention | undefined {
  const remaining = parent.remaining();
  const child = new SourceSemanticResourceLedger({
    work_units: Math.max(0, remaining.work_units - budget.finalization_reserve - budget.min_envelope),
    memory_bytes: Math.max(0, remaining.memory_bytes - budget.min_envelope)
  });
  try {
    return compute(child);
  } catch (error) {
    if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
    return undefined;
  } finally {
    parent.charge(child.spentWork, child.spentBytes, "optional semantic attention");
  }
}

export function attachOptionalAttention(
  body: SourceSemanticResultBody, parent: SourceSemanticResourceLedger,
  budget: OptionalAttentionBudget, compute: OptionalAttentionCompute
): SourceSemanticResultBody {
  const attention = runOptionalAttention(parent, budget, compute);
  return attention === undefined ? body : { ...body, attention };
}

export function singleOptionalAttention(
  admission: Admission, execution: SourceSemanticExecutionPlan, state: FieldEngineState,
  acceptedBranchIndices: ReadonlySet<number>
): OptionalAttentionCompute {
  return (child) => sourceSemanticBranchAttention(admission, execution, state, acceptedBranchIndices, child);
}

export function groupedOptionalAttention(
  admission: Admission, projected: readonly OptionalAttentionPhase[],
  unprojected: readonly SourceSemanticGroupPhase[], incomplete: boolean
): OptionalAttentionCompute {
  return (child) => mergeComputedAttention([
    ...projected.map((row) => sourceSemanticBranchAttention(
      admission, row.execution, row.state, row.acceptedBranchIndices, child)),
    unexecutedGroupAttention(admission, unprojected, child)
  ], child, incomplete);
}

