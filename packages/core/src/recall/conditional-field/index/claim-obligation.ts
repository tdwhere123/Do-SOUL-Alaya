import {
  productSubjectId,
  type ClaimState,
  type FieldValue,
  type QueryView
} from "@do-soul/alaya-protocol";
import { parseBindingContext, type BindingContextStore } from "../engine/binding-environment.js";

export function claimObligationAccepts(
  value: FieldValue,
  view: QueryView,
  claim: ClaimState,
  bindingContexts?: BindingContextStore
): boolean {
  const env = parseBindingContext(value.state.binding_context, bindingContexts);
  const subject = productSubjectId(value.state);
  for (const demand of view.claim_demands ?? []) {
    if (env.get(demand.variable) !== subject) continue;
    if (demand.required_claim === "any") continue;
    if (claim !== demand.required_claim) return false;
  }
  return true;
}
