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

export type LocalAdvanceBlock =
  | "unresolved_guard"
  | "missing_measurement"
  | "missing_target_revision"
  | "demand";

type LocalStep = Readonly<{ kind: "work"; retained_bytes?: number }>
  | Readonly<{
    kind: "effect";
    effect: Readonly<{
      unresolved_guard?: boolean;
      missing_measurement?: boolean;
      missing_target_revision?: boolean;
      relation_demand?: unknown;
      source_fact_demand?: unknown;
    }>;
  }>;

type LocalMeter = { charge(work: number, bytes: number, phase?: string): void };

/** Blocking effects stay distinct from absence so a checker cannot treat them as no row. */
export function settleLocalComputation<T>(
  computation: Generator<LocalStep, T, void>,
  meter: LocalMeter
): { kind: "admitted"; value: T } | { kind: "blocked"; reason: LocalAdvanceBlock } {
  let step = computation.next();
  while (!step.done) {
    const current = step.value;
    if (current.kind === "work") meter.charge(1, current.retained_bytes ?? 0, "local advance");
    else {
      const reason = blockReason(current.effect);
      if (reason !== undefined) return { kind: "blocked", reason };
    }
    step = computation.next();
  }
  return { kind: "admitted", value: step.value };
}

function blockReason(effect: Extract<LocalStep, { kind: "effect" }>["effect"]): LocalAdvanceBlock | undefined {
  if (effect.unresolved_guard === true) return "unresolved_guard";
  if (effect.missing_measurement === true) return "missing_measurement";
  if (effect.missing_target_revision === true) return "missing_target_revision";
  if (effect.relation_demand !== undefined || effect.source_fact_demand !== undefined) return "demand";
  return undefined;
}

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
