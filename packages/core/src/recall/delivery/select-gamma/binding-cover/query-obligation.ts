import type { RecallAnswerShape } from "../../../query/recall-answer-shape-plan.js";
import type { OpenSemanticFactorCompositionReceipt } from
  "../../../field/open-semantic-factors/composition.js";
import type { BindingQueryObligation } from "./types.js";

export function resolveBindingQueryObligation(params: Readonly<{
  readonly composition?: Readonly<OpenSemanticFactorCompositionReceipt>;
  readonly querySoughtFacets?: readonly string[];
  readonly answerShape?: RecallAnswerShape | null;
}>): BindingQueryObligation {
  return Object.freeze({
    answer_variable_ids: Object.freeze(answerVariableIds(params.composition)),
    obligation_facets: Object.freeze([...(params.querySoughtFacets ?? [])]),
    answer_shape: params.answerShape ?? null
  });
}

function answerVariableIds(
  composition: Readonly<OpenSemanticFactorCompositionReceipt> | undefined
): readonly string[] {
  if (composition === undefined || composition.status !== "composed") {
    return [];
  }
  if (composition.result_variable_ids.length > 0) {
    return composition.result_variable_ids;
  }
  return Object.freeze(composition.variable_collections.map(
    ({ variable_id: variableId }) => variableId
  ));
}
