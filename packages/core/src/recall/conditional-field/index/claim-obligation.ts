import {
  productSubjectId,
  type ProductStateKey,
  type ClaimState,
  type FieldValue,
  type QueryView
} from "@do-soul/alaya-protocol";
import { parseBindingContext, type BindingContextStore } from "../engine/binding-environment.js";

export function claimDemandForState(
  state: ProductStateKey,
  view: QueryView,
  bindingContexts?: BindingContextStore
): NonNullable<QueryView["claim_demands"]>[number] | undefined {
  const env = parseBindingContext(state.binding_context, bindingContexts);
  return view.claim_demands?.find((demand) => env.get(demand.variable) === productSubjectId(state));
}

/** Claim evidence is read from the first bound argument of the selected demand. */
export function claimEvidenceDemandForState(
  state: ProductStateKey,
  view: QueryView,
  bindingContexts?: BindingContextStore
): Readonly<{ subject: string; predicate: string }> | undefined {
  if (state.target.kind !== "memory_entry" || state.program_state !== "accepting") return undefined;
  const demand = claimDemandForState(state, view, bindingContexts);
  const variable = demand?.argument_variables[0];
  if (demand === undefined || variable === undefined) return undefined;
  const subject = parseBindingContext(state.binding_context, bindingContexts).get(variable);
  return subject === undefined ? undefined : { subject, predicate: demand.proposition_kind };
}

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
