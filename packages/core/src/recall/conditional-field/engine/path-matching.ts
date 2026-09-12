import {
  HARD_IDENTITY_TRANSFER_ID,
  HARD_IDENTITY_TRANSFER_VERSION,
  MILLIGRADE_TOP,
  type AdmittedTransfer,
  type ProductStateKey,
  type Transition
} from "@do-soul/alaya-protocol";
import type { QueryRelation } from "../query/compile-query.js";
import {
  STORED_RELATION_KIND,
  SUPPORTED_RELATION_ALIASES
} from "../query/ordinary-language.js";
import {
  HARD_IDENTITY_CAP_CONTRACT,
  hardIdentityCapContractId
} from "../cap-contract.js";
import {
  decideGuards,
  encodeBindingContext,
  parseBindingContext,
  unifyBinding,
  type BoundSourceFacts
} from "./binding-environment.js";
import type { BindingContextStore } from "./binding-environment.js";

export type AdjacencyRow = Readonly<{
  readonly assertionId: string;
  readonly source_revision?: string;
  readonly sourceObjectId: string;
  readonly targetObjectId: string;
  readonly predicate: string;
  readonly validity?: Transition["validity"];
  readonly resolutionKind?: string | null;
}>;

export type NamedKindOverlay = Readonly<Record<string, Readonly<{
  readonly milligrades?: number;
  readonly applicable: boolean;
  readonly role?: string;
}>>>;

export type RelationTransferAdmission = Readonly<{
  readonly query_id: string;
  readonly instance_id: string;
  readonly revision_id: string | undefined;
  readonly hypothesis_id: string;
  readonly binding: string;
  readonly time_state: string;
}>;

export type AdmittedRelationStrength = Readonly<{
  readonly milligrades: number;
  readonly applicable: true;
  readonly transfer_id: string;
  readonly transfer_version: string;
  readonly cap_contract_id: string;
  readonly instance_id: string;
  readonly revision_id: string;
}>;

export function relationMatches(programKind: string, storedPredicate: string): boolean {
  if (programKind === storedPredicate) return true;
  if (programKind === STORED_RELATION_KIND) return false;
  return (SUPPORTED_RELATION_ALIASES[programKind] ?? []).includes(storedPredicate);
}

export function overlayBlocksTransfer(
  overlay: NamedKindOverlay,
  storedPredicate: string,
  programKind: string
): boolean {
  const declared = overlay[storedPredicate] ?? overlay[programKind];
  return declared?.applicable === false;
}

export function relationStrength(
  relation: QueryRelation,
  overlay: NamedKindOverlay,
  storedPredicate: string,
  admission: RelationTransferAdmission
): AdmittedRelationStrength | undefined {
  if (!relationMatches(relation.relation_kind, storedPredicate)) return undefined;
  if (overlayBlocksTransfer(overlay, storedPredicate, relation.relation_kind)) return undefined;
  if (admission.revision_id === undefined || admission.revision_id.length === 0) return undefined;
  if (admission.instance_id.length === 0) return undefined;
  const transfer = admitHardIdentityTransfer(admission);
  return {
    milligrades: transfer.milligrades,
    applicable: true,
    transfer_id: transfer.transfer_id,
    transfer_version: transfer.transfer_version,
    cap_contract_id: hardIdentityCapContractId(),
    instance_id: transfer.relation_instance_id,
    revision_id: transfer.relation_revision
  };
}

function admitHardIdentityTransfer(admission: RelationTransferAdmission): AdmittedTransfer {
  return {
    schema_version: 1,
    transfer_id: HARD_IDENTITY_TRANSFER_ID,
    transfer_version: HARD_IDENTITY_TRANSFER_VERSION,
    query_id: admission.query_id,
    relation_instance_id: admission.instance_id,
    relation_revision: admission.revision_id!,
    direction: "forward",
    hypothesis_id: admission.hypothesis_id,
    binding: admission.binding,
    time_state: admission.time_state,
    cap_contract: HARD_IDENTITY_CAP_CONTRACT,
    milligrades: MILLIGRADE_TOP
  };
}

export function unifyAdvance(
  from: ProductStateKey,
  relation: QueryRelation,
  row: AdjacencyRow,
  bindingContexts?: BindingContextStore
): Readonly<{ readonly env: Map<string, string>; readonly binding: string }> | undefined {
  const source = unifyBinding(
    parseBindingContext(from.binding_context, bindingContexts),
    relation.source_variable,
    row.sourceObjectId
  );
  if (source === undefined) return undefined;
  const target = unifyBinding(source, relation.target_variable, row.targetObjectId);
  if (target === undefined) return undefined;
  return { env: target, binding: encodeBindingContext(target, bindingContexts) };
}

export function inactiveResolution(kind: string | null | undefined): boolean {
  return kind === "retracted" || kind === "expired" || kind === "contradicted";
}

export function observedTargetRevision(
  targetObjectId: string,
  sourceFacts: ReadonlyMap<string, BoundSourceFacts> | undefined,
  liveStates: Iterable<ProductStateKey>
): string | undefined {
  const fact = sourceFacts?.get(targetObjectId)?.source_revision;
  if (fact !== undefined && fact.length > 0) return fact;
  for (const state of liveStates) {
    if (state.target.kind === "memory_entry" && state.target.object_id === targetObjectId) {
      return state.target.source_revision;
    }
  }
  return undefined;
}

/** Both unary transfers and hyperedge premises preserve unresolved admission. */
export function* admitRelationRow(
  relation: QueryRelation,
  from: ProductStateKey,
  row: AdjacencyRow,
  input: Readonly<{
    query_id: string;
    overlay: NamedKindOverlay;
    sourceFacts?: ReadonlyMap<string, BoundSourceFacts>;
    bindingContexts?: BindingContextStore;
    liveStates: Iterable<ProductStateKey>;
  }>
): import("./path-effect-cursor.js").PathComputation<Readonly<{
  binding: string;
  targetRevision: string;
  revisionId: string;
  strength: AdmittedRelationStrength;
}> | undefined> {
  if (overlayBlocksTransfer(input.overlay, row.predicate, relation.relation_kind)) return;
  const unified = unifyAdvance(from, relation, row, input.bindingContexts);
  if (unified === undefined) return;
  const decision = decideGuards([relation.guard], unified.env, input.sourceFacts ?? new Map(),
    { sourceId: row.sourceObjectId, targetId: row.targetObjectId });
  if (decision === "false") return;
  if (decision === "unresolved") {
    yield { kind: "effect", effect: { observation_id: `guard:${row.assertionId}:${from.program_state}`, unresolved_guard: true } };
    return;
  }
  const targetRevision = observedTargetRevision(row.targetObjectId, input.sourceFacts, input.liveStates);
  if (targetRevision === undefined) {
    yield { kind: "effect", effect: { observation_id: `revision:${row.assertionId}:${from.program_state}`,
      unresolved_guard: true, missing_target_revision: true } };
    return;
  }
  const fact = input.sourceFacts?.get(row.sourceObjectId)?.source_revision;
  const revisionId = row.source_revision || fact
    || (from.target.kind === "memory_entry" ? from.target.source_revision : from.target.source_version);
  const strength = relationStrength(relation, input.overlay, row.predicate, {
    query_id: input.query_id, instance_id: row.assertionId, revision_id: revisionId,
    hypothesis_id: from.hypothesis_id, binding: unified.binding, time_state: from.time_state
  });
  if (strength === undefined) {
    yield { kind: "effect", effect: { observation_id: `adjacency:${row.assertionId}:${from.hypothesis_id}:${from.program_state}`,
      missing_measurement: true } };
    return;
  }
  if (strength.milligrades <= relation.threshold_milligrades) return;
  return { binding: unified.binding, targetRevision, revisionId, strength };
}
