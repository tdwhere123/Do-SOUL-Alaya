import {
  productSubjectId,
  type ClaimState,
  type FieldValue,
  type QueryView
} from "@do-soul/alaya-protocol";
import { parseBindingContext } from "../engine/binding-environment.js";

export function claimObligationAccepts(
  value: FieldValue,
  view: QueryView,
  claim: ClaimState
): boolean {
  const env = parseBindingContext(value.state.binding_context);
  const subject = productSubjectId(value.state);
  for (const demand of view.claim_demands ?? []) {
    if (env.get(demand.variable) !== subject) continue;
    if (demand.required_claim === "any") continue;
    if (demand.required_claim === "supported" && claim !== "supported") return false;
  }
  return true;
}
