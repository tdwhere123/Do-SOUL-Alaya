import {
  interpretationNodeIdentity,
  type InterpretationNodeCoordinate,
  type SourceEvidenceTarget,
  type SourceSemanticConsumedLeaf
} from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import type { RelationObserverRow, SourceObserverRow } from "../conditional-field/observers/observe-ports.js";
import type { SourceSemanticBranchPlan } from "./source-semantic-branch-plan.js";

export function sourceSemanticRelationKey(...parts: readonly (string | number)[]): string {
  return JSON.stringify(["source-semantic-relations-v6", ...parts]);
}

type PremiseMeter = { charge(work: number, bytes: number, phase?: string): void };

export type PremiseRowContext = Readonly<{
  meter: PremiseMeter;
  context_id: string;
  interpretation_id: string;
  scope: string;
  source_target: SourceEvidenceTarget;
  branches?: readonly SourceSemanticBranchPlan[];
  sourceValidity?: Readonly<{ valid_from: string | null; valid_to: string | null }>;
}>;

export type PremiseRowState = {
  readonly nodes: Map<string, SourceObserverRow>;
  readonly coordinates: Map<string, InterpretationNodeCoordinate>;
  readonly rows: RelationObserverRow[];
  readonly adjacency: Map<string, RelationObserverRow[]>;
  readonly positions: Map<string, number>;
  readonly origins: Map<string, SourceSemanticConsumedLeaf>;
  readonly aliases: Map<string, string>;
  readonly input: PremiseRowContext;
};

export type PremiseRowSink = {
  node(id: string): void;
  edge(from: string, to: string, predicate: string, leaf?: SourceSemanticConsumedLeaf): void;
  self(id: string, parts: readonly (string | number)[], leaf?: SourceSemanticConsumedLeaf): void;
  readonly branches: readonly SourceSemanticBranchPlan[] | undefined;
  readonly aliases: ReadonlyMap<string, string>;
  readonly slotNodes: ReadonlyMap<string, string>;
};

export function premiseRow(
  contextId: string,
  interpretationId: string,
  ordinal: number,
  source: InterpretationNodeCoordinate,
  target: InterpretationNodeCoordinate,
  predicate: string
): RelationObserverRow {
  return {
    assertionId: `${contextId}/${String(ordinal).padStart(6, "0")}`,
    sourceObjectId: interpretationNodeIdentity(source),
    targetObjectId: interpretationNodeIdentity(target),
    resultObjectId: interpretationNodeIdentity(target),
    predicate,
    validity: { kind: "interpretation", packet_id: interpretationId, hypothesis_id: contextId },
    interpretation_source: source,
    interpretation_target: target,
    source_revision: interpretationId
  };
}

export function recordPremiseNode(state: PremiseRowState, id: string): void {
  state.input.meter.charge(1, 1024, "premise node");
  const coordinate = { packet_id: state.input.interpretation_id, hypothesis_id: state.input.context_id, node_id: id };
  const objectId = interpretationNodeIdentity(coordinate);
  state.coordinates.set(id, coordinate);
  state.nodes.set(objectId, {
    object_id: objectId,
    sourceRevision: state.input.interpretation_id,
    target: state.input.source_target,
    interpretation_node: coordinate,
    lifecycle_state: "active",
    scope_class: state.input.scope,
    ...state.input.sourceValidity
  });
}

export function appendPremiseEdge(
  state: PremiseRowState,
  from: string,
  to: string,
  predicate: string,
  leaf?: SourceSemanticConsumedLeaf
): RelationObserverRow {
  const source = state.coordinates.get(from), target = state.coordinates.get(to);
  if (source === undefined || target === undefined) throw new CoreError("OBLIGATION_VIOLATION", "premise endpoint is absent");
  state.input.meter.charge(1, 2048 + 4 * predicate.length, "premise edge");
  const row = premiseRow(state.input.context_id, state.input.interpretation_id, state.rows.length, source, target, predicate);
  if (leaf !== undefined) state.origins.set(row.assertionId, premiseLeafProvenance(leaf, state.aliases));
  const key = JSON.stringify([row.sourceObjectId, predicate]);
  const bucket = state.adjacency.get(key) ?? [];
  state.positions.set(row.assertionId, bucket.length);
  bucket.push(row);
  state.adjacency.set(key, bucket);
  state.rows.push(row);
  return row;
}

function premiseLeafProvenance(
  leaf: SourceSemanticConsumedLeaf,
  aliases: ReadonlyMap<string, string>
): SourceSemanticConsumedLeaf {
  const result = { ...leaf };
  for (const [field, derived] of [["occurrence", "derived_node"], ["parent", "derived_parent"], ["target", "derived_target"]] as const) {
    const value = result[field];
    if (value === undefined || !value.startsWith("@")) continue;
    result[derived] = value;
    const template = aliases.get(value);
    if (template === undefined) delete result[field];
    else result[field] = template;
  }
  return result;
}

/** Locator index for admitted rows. It does not store instances or finite derived facts. */
export class PremiseRowIndex implements PremiseRowSink, PremiseRowState {
  readonly nodes = new Map<string, SourceObserverRow>();
  readonly coordinates = new Map<string, InterpretationNodeCoordinate>();
  readonly rows: RelationObserverRow[] = [];
  readonly adjacency = new Map<string, RelationObserverRow[]>();
  readonly positions = new Map<string, number>();
  readonly origins = new Map<string, SourceSemanticConsumedLeaf>();
  readonly aliases = new Map<string, string>();
  readonly slotNodes = new Map<string, string>();
  private readonly byLocator = new Map<string, RelationObserverRow[]>();
  constructor(readonly input: PremiseRowContext) {}
  get branches(): readonly SourceSemanticBranchPlan[] | undefined { return this.input.branches; }
  node(id: string): void { recordPremiseNode(this, id); }
  edge(from: string, to: string, predicate: string, leaf?: SourceSemanticConsumedLeaf): void {
    const row = appendPremiseEdge(this, from, to, predicate, leaf);
    const locator = `${row.sourceObjectId}\0${row.predicate}\0${row.targetObjectId}`;
    const found = this.byLocator.get(locator) ?? [];
    found.push(row);
    this.byLocator.set(locator, found);
  }
  self(id: string, parts: readonly (string | number)[], leaf?: SourceSemanticConsumedLeaf): void {
    this.edge(id, id, sourceSemanticRelationKey(...parts), leaf);
  }
  lookup(from: string, predicate: string, to: string): readonly RelationObserverRow[] {
    return this.byLocator.get(`${from}\0${predicate}\0${to}`) ?? [];
  }
}
