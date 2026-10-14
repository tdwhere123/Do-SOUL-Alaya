import type { FieldValue, IndexEntry, QueryProgram } from "@do-soul/alaya-protocol";
import { hardIdentityCapContractId } from "../../../../recall/conditional-field/cap-contract.js";
import { parseBindingContext } from "../../../../recall/conditional-field/engine/binding-environment.js";
import type { FieldEngineState } from "../../../../recall/conditional-field/engine/field-engine.js";
import type { RelationObserverRow, SourceObserverRow } from "../../../../recall/conditional-field/observers/observe-ports.js";
import { coalesceQualifiedResults, finiteExpressionDenotation,
  type FiniteExpression, type FiniteRelation, type FiniteWorld, type QualifiedResult } from "../engine/qualified-expression.oracle.js";
import { extractQualifiedResults, observeQualifiedExpression } from "../engine/qualified-expression-native.fixture.js";

const CLOCK = "2026-09-10T00:00:00.000Z";
const START = "2026-01-01T00:00:00.000Z";
type CompletionBits = Readonly<{ left: boolean; right: boolean; unseen: boolean; guard: boolean; third?: boolean }>;
export type KnownRegions = Readonly<{ left?: boolean; right?: boolean; unseen?: boolean; guard?: boolean; third?: boolean }>;

export function completionBits(): CompletionBits[] {
  return Array.from({ length: 16 }, (_, mask) => ({ left: !!(mask & 1), right: !!(mask & 2),
    unseen: !!(mask & 4), guard: !!(mask & 8) }));
}

/** Plain finite-world facts feed independently authored native and reference expressions. */
export function residualWorld(bits: CompletionBits) {
  const predicates = ["left", "right", ...(bits.third === undefined ? [] : ["third"])];
  const seeds = ["A", ...(bits.unseen ? ["B"] : [])];
  const rows: FiniteRelation[] = ["A", "B"].flatMap((source) => predicates
    .filter((predicate) => bits[predicate as "left" | "right" | "third"])
    .map((predicate) => ({ id: `${source}-${predicate}`, source, target: source === "A" ? "Z" : "Y",
      predicate, revision: `edge-${source}-${predicate}`, valid_from: START })));
  const sources = Object.fromEntries(["A", "B", "Y", "Z", "G"].map((id) =>
    [id, { revision: `rev-${id}`, scope: id === "G" && !bits.guard ? "private" : "project" }]));
  const world: FiniteWorld = { rows, sources, seeds: seeds.map((object) => ({ object, hypothesis: "h0", bindings: { c: "G" } })),
    asOf: CLOCK, authorizedScopes: null, contractId: hardIdentityCapContractId() };
  const expression: FiniteExpression = { kind: "and", terms: predicates.map((relation) => ({ kind: "atom",
    relation, source: "x", target: "a", ...(relation === "right" ? { guard: { variable: "c", scope: "project" } } : {}) })) };
  const program: QueryProgram = { schema_version: 1, kind: "hyperedge", join: "and", premises: predicates.map((relation_kind) =>
    ({ schema_version: 1, kind: "relation", relation_kind, source_variable: "x", target_variable: "a",
      guard: relation_kind === "right"
        ? { schema_version: 1, kind: "authorization", variable: "c", authorization_scope: "project", time_scope: "none", verdict: "unresolved" }
        : { schema_version: 1, kind: "query_predicate", verdict: "true", time_scope: "none" },
      facet_mode: "same_path", threshold_milligrades: 0 })) };
  const nativeRows: RelationObserverRow[] = rows.map((row) => ({ assertionId: row.id, sourceObjectId: row.source,
    targetObjectId: row.target, resultObjectId: row.target, predicate: row.predicate, source_revision: row.revision,
    validity: { kind: "open", valid_from: START } }));
  const nativeSources: Record<string, SourceObserverRow> = Object.fromEntries(Object.entries(sources).map(([id, source]) =>
    [id, { object_id: id, sourceRevision: source.revision, lifecycle_state: "active", scope_class: source.scope as "project" | "private" }]));
  const origins = new Map(rows.map((row) => [row.id, { id: row.id, revision: row.revision }]));
  return { bits, world, expression, program, nativeRows, nativeSources, origins, seeds };
}

type ResidualWorld = ReturnType<typeof residualWorld>;

export function observeWorld(world: ResidualWorld, known?: KnownRegions, extra: { work?: number; resume?: FieldEngineState } = {}) {
  const sources = { ...world.nativeSources };
  if (known !== undefined && known.guard === undefined) sources.G = {
    object_id: "G", sourceRevision: "rev-G", lifecycle_state: "active" };
  return observeQualifiedExpression(world.program, world.nativeRows, { ...extra, sources, asOf: CLOCK, pageSize: 1,
    seeds: known !== undefined && known.unseen === undefined ? ["A"] : world.seeds,
    seedDomainOpen: known !== undefined && known.unseen === undefined,
    unavailableRelations: known === undefined ? [] : ["left", "right", ...(world.bits.third === undefined ? [] : ["third"])]
      .filter((predicate) => known[predicate as "left" | "right" | "third"] === undefined) });
}

export function completeWorld(world: ResidualWorld) {
  const state = observeWorld(world);
  return { world, state, expected: finiteExpressionDenotation(world.expression, world.world).results,
    actual: coalesceQualifiedResults(extractQualifiedResults(state, world.origins)) };
}

export function compatible(bits: CompletionBits, known: KnownRegions): boolean {
  return Object.entries(known).every(([key, value]) => bits[key as keyof CompletionBits] === value);
}

export function qualifiedIdentity(row: Pick<QualifiedResult, "target" | "hypothesis" | "bindings" | "time_state">): string {
  return JSON.stringify([row.target, row.hypothesis, row.bindings, row.time_state]);
}

export function valueIdentity(value: FieldValue, state: FieldEngineState): string {
  if (value.state.target.kind !== "memory_entry") throw new Error("world fixture expects a memory entry");
  return qualifiedIdentity({ target: value.state.target, hypothesis: value.state.hypothesis_id,
    bindings: [...parseBindingContext(value.state.binding_context, state.binding_contexts)].sort(([a], [b]) => a.localeCompare(b)),
    time_state: value.state.time_state });
}

export function entryIdentity(entry: IndexEntry, state: FieldEngineState): string {
  if (entry.target.kind !== "memory_entry") throw new Error("world fixture expects a memory entry");
  return qualifiedIdentity({ target: entry.target, hypothesis: entry.hypothesis_id,
    bindings: [...parseBindingContext(entry.output_binding, state.binding_contexts)].sort(([a], [b]) => a.localeCompare(b)),
    time_state: entry.time_state ?? "as_of" });
}
