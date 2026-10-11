import {
  HARD_IDENTITY_TRANSFER_ID,
  HARD_IDENTITY_TRANSFER_VERSION,
  MILLIGRADE_TOP,
  productEndpointId,
  type Derivation,
  type ProductStateKey,
  type Transition
} from "@do-soul/alaya-protocol";
import { hardIdentityCapContractId } from "../cap-contract.js";
import type { QueryRelation } from "../query/compile-query.js";
import type { HyperedgePremise } from "../reference/accepting-projection.js";
import type { BoundSourceFacts, BindingContextStore } from "./binding-environment.js";
import { leafDerivation } from "./path-derivation.js";
import { groundedOutputDerivations } from "./output-derivations.js";
import { ACCEPTING_PROGRAM_STATE } from "./program-automaton.js";
import type { PathComputation } from "./path-effect-cursor.js";
import {
  admitRelationRow,
  inactiveResolution,
  observedTargetRevision,
  relationMatches,
  type AdjacencyRow,
  type NamedKindOverlay
} from "./path-matching.js";

export type PremiseAssignment = HyperedgePremise & Readonly<{
  readonly target_object_id: string;
  readonly milligrades: number;
  readonly validity: Transition["validity"];
  readonly relation_kind: string;
  readonly observation_id: string;
  readonly leaf_id: string;
  readonly derivation: Derivation;
  readonly derivations: readonly Derivation[];
  readonly cap_contract_id?: string;
  readonly transfer_id?: string;
  readonly transfer_version?: string;
  readonly instance_id?: string;
  readonly revision_id?: string;
}>;

export function openValidity(from: ProductStateKey): Transition["validity"] {
  if (from.interpretation_node !== undefined) return { kind: "interpretation",
    packet_id: from.interpretation_node.packet_id, hypothesis_id: from.hypothesis_id };
  return { kind: "open", valid_from: "2026-01-01T00:00:00.000Z" };
}

export function terminalAssignment(
  from: ProductStateKey,
  target: string,
  milligrades: number,
  validity: Transition["validity"],
  relationKind: string,
  binding = from.binding_context,
  leafId = `${productEndpointId(from)}:${target}:${relationKind}`
): PremiseAssignment {
  const derivation = leafDerivation({
    derivation_id: `leaf:${leafId}`,
    observation_id: leafId,
    leaf_id: leafId,
    association_milligrades: milligrades
  });
  return {
    hypothesis_id: from.hypothesis_id,
    binding_context: binding,
    time_state: from.time_state,
    present: true,
    target_object_id: target,
    milligrades,
    validity,
    relation_kind: relationKind,
    observation_id: leafId,
    leaf_id: leafId,
    derivation,
    derivations: [derivation],
    cap_contract_id: hardIdentityCapContractId(),
    transfer_id: HARD_IDENTITY_TRANSFER_ID,
    transfer_version: HARD_IDENTITY_TRANSFER_VERSION
  };
}

export function* assignmentFromRow(
  relation: QueryRelation,
  from: ProductStateKey,
  row: AdjacencyRow,
  input: Readonly<{
    readonly query_id: string;
    readonly overlay: NamedKindOverlay;
    readonly sourceFacts?: ReadonlyMap<string, BoundSourceFacts>;
    readonly bindingContexts?: BindingContextStore;
    readonly liveStates: Iterable<ProductStateKey>;
    readonly observedStates?: Iterable<ProductStateKey>;
  }>
): PathComputation<PremiseAssignment | undefined> {
  if (row.sourceObjectId !== productEndpointId(from)) return undefined;
  if (!relationMatches(relation.relation_kind, row.predicate)) return undefined;
  if (row.validity === undefined || inactiveResolution(row.resolutionKind)) return undefined;
  const admitted = yield* admitRelationRow(relation, from, row, {
    ...input, liveStates: input.observedStates ?? input.liveStates
  });
  if (admitted === undefined) return;
  const { binding, revisionId, strength } = admitted;
  const leafId = row.assertionId;
  const derivation = leafDerivation({
    derivation_id: `leaf:${leafId}`,
    observation_id: leafId,
    leaf_id: leafId,
    association_milligrades: strength.milligrades,
    source_revision: revisionId
  });
  return {
    hypothesis_id: from.hypothesis_id,
    binding_context: binding,
    time_state: from.time_state,
    present: true,
    target_object_id: row.targetObjectId,
    milligrades: strength.milligrades,
    validity: row.validity,
    relation_kind: row.predicate,
    observation_id: leafId,
    leaf_id: leafId,
    derivation,
    derivations: [derivation],
    cap_contract_id: strength.cap_contract_id,
    transfer_id: strength.transfer_id,
    transfer_version: strength.transfer_version,
    instance_id: strength.instance_id,
    revision_id: strength.revision_id
  };
}

export function* groundPremiseAssignments(
  from: ProductStateKey,
  starts: readonly ProductStateKey[],
  visited: ReadonlyMap<string, ProductStateKey>,
  transitions: readonly Transition[],
  derivations: ReadonlyMap<string, Derivation>,
  roots: Readonly<Record<string, string>>
): PathComputation<readonly PremiseAssignment[]> {
  const groundDerivations: Derivation[] = [];
  for (const row of derivations.values()) { yield { kind: "work", retained_bytes: 8 }; groundDerivations.push(row); }
  const groundInput = { seeds: starts.map((state) => ({ schema_version: 1 as const, state, milligrades: MILLIGRADE_TOP })),
    transitions, derivations: groundDerivations, transition_derivations: roots, allowance: 1 };
  let grounded = groundedOutputDerivations(groundInput);
  while (!grounded.complete) {
    yield { kind: "work", retained_bytes: grounded.admitted_bytes };
    grounded = groundedOutputDerivations({ ...groundInput, progress: grounded.progress });
  }
  yield { kind: "work", retained_bytes: grounded.admitted_bytes };
  const forest: Derivation[] = [];
  for (const row of grounded.progress.forest.values()) { yield { kind: "work", retained_bytes: 8 }; forest.push(row); }
  const assignments: PremiseAssignment[] = [];
  for (const [key, node] of visited) {
    yield { kind: "work", retained_bytes: 256 };
    if (node.program_state !== ACCEPTING_PROGRAM_STATE) continue;
    const rootId = grounded.progress.root_map.get(key)?.[0];
    const root = rootId === undefined ? undefined : grounded.progress.forest.get(rootId);
    const grade = grounded.progress.grades.get(key);
    if (root === undefined || grade === undefined) continue;
    assignments.push({ ...terminalAssignment(from, productEndpointId(node), grade, openValidity(from), "path", node.binding_context),
      derivation: root, derivations: forest });
  }
  return assignments;
}
