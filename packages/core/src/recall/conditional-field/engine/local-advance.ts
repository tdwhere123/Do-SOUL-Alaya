import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  type ProductStateKey,
  type Transition
} from "@do-soul/alaya-protocol";
import {
  alignOutgoingBinding,
  type BindingContextStore,
  type BoundSourceFacts
} from "./binding-environment.js";
import {
  retargetRelationProduct,
  type AdjacencyRow,
  type AdmittedRelationStrength
} from "./path-matching.js";
import type { ProgramAutomaton } from "./program-automaton.js";

export function relationTransition(
  row: AdjacencyRow,
  from: ProductStateKey,
  to: ProductStateKey,
  strength: AdmittedRelationStrength
): Transition | undefined {
  if (row.validity === undefined) return undefined;
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    from,
    to,
    relation_kind: row.predicate,
    instance_id: strength.instance_id,
    revision_id: strength.revision_id,
    transfer_id: strength.transfer_id,
    transfer_version: strength.transfer_version,
    strength_milligrades: strength.milligrades,
    validity: row.validity,
    applicable: true,
    cap_contract_id: strength.cap_contract_id
  };
}

/** One qualified product per accepting program state; callers still charge the per-state work yield. */
export function advanceProducts(
  automaton: ProgramAutomaton,
  advance: Readonly<{ readonly to: readonly string[] }>,
  row: AdjacencyRow,
  from: ProductStateKey,
  admitted: Readonly<{ binding: string; targetRevision: string }>,
  ctx: Readonly<{
    bindingContexts?: BindingContextStore;
    sourceFacts?: ReadonlyMap<string, BoundSourceFacts>;
  }>
): readonly { programState: string; to: ProductStateKey }[] {
  const products: { programState: string; to: ProductStateKey }[] = [];
  for (const programState of advance.to) {
    const binding = alignOutgoingBinding(
      admitted.binding, row.targetObjectId, automaton, programState, ctx.bindingContexts
    );
    if (binding === undefined) continue;
    products.push({
      programState,
      to: retargetRelationProduct(from, row.targetObjectId, admitted.targetRevision, {
        program_state: programState,
        binding_context: binding
      }, ctx.sourceFacts)
    });
  }
  return products;
}
