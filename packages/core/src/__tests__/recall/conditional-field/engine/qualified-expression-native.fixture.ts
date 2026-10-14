import { productEndpointId, type Derivation, type ProductStateKey, type QueryHypothesis,
  type QueryProgram } from "@do-soul/alaya-protocol";
import { observeField } from "../../../../recall/runtime/conditional-field-observe.js";
import { compileConditionalFieldQuery } from "../../../../recall/conditional-field/query/compile-query.js";
import { parseBindingContext } from "../../../../recall/conditional-field/engine/binding-environment.js";
import type { FieldEngineState } from "../../../../recall/conditional-field/engine/field-engine.js";
import { groundedOutputDerivations } from "../../../../recall/conditional-field/engine/output-derivations.js";
import { leafDerivation, seedDerivationIdentity } from "../../../../recall/conditional-field/engine/path-derivation.js";
import { compileProgramAutomaton } from "../../../../recall/conditional-field/engine/program-automaton.js";
import type { ObserverReaders, RelationObserverRow, SourceObserverRow } from "../../../../recall/conditional-field/observers/observe-ports.js";
import { productStateNodeId } from "../../../../recall/conditional-field/reference/bind-max-min.js";
import { createDerivationAlternativeExpander } from "../evidence/derivation-alternatives.oracle.js";
import { defaultBudget, defaultView, SNAPSHOT_ID } from "../reference/deployment.fixture.js";
import type { QualifiedResult } from "./qualified-expression.oracle.js";

type NativeOptions = Readonly<{
  seeds?: readonly string[];
  hypotheses?: readonly QueryHypothesis[];
  sources?: Readonly<Record<string, SourceObserverRow>>;
  authorizedScopes?: readonly string[] | null;
  asOf?: string;
  pageSize?: number;
  work?: number;
  resume?: FieldEngineState;
}>;
type PhysicalOrigins = ReadonlyMap<string, Readonly<{ id: string; revision: string }>>;

/** Uses the public typed compiler and the physical observer admission path. */
export function observeQualifiedExpression(
  program: QueryProgram, rows: readonly RelationObserverRow[], options: NativeOptions = {}
): FieldEngineState {
  const asOf = options.asOf ?? "2026-09-10T00:00:00.000Z";
  const authorizedScopes = options.authorizedScopes === undefined ? null : options.authorizedScopes;
  const budget = defaultBudget({ work_units: options.work ?? 1_000_000, memory_bytes: 64_000_000 });
  const interpretation = compileConditionalFieldQuery({ source: "typed", program, budget,
    snapshot_id: SNAPSHOT_ID, query_id: "qualified-expression", interpretation_clock: asOf,
    view: defaultView(), authorized_scopes: authorizedScopes,
    hypotheses: options.hypotheses ?? [{ schema_version: 1, hypothesis_id: "h0",
      bindings: [{ schema_version: 1, variable: "c", value: "G" }] }] });
  if (interpretation.status !== "resolved" && interpretation.status !== "hypotheses") {
    throw new Error(`typed expression admission: ${interpretation.status}`);
  }
  return observeField(interpretation, { workspace_id: "ws", query_text: "qualified expression", as_of: asOf,
    authorized_scopes: authorizedScopes, budget, readers: fixtureReaders(rows, options),
    ...(options.resume === undefined ? {} : { resume_field: options.resume }) });
}

function fixtureReaders(rows: readonly RelationObserverRow[], options: NativeOptions): ObserverReaders {
  const seeds = [...options.seeds ?? ["A", "B"]].sort();
  const pageSize = options.pageSize ?? 100;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new Error("fixture page size must be positive");
  return {
    lexical: ({ afterObjectId, limit, nativeLimit }) => {
      const remaining = seeds.filter((id) => id > (afterObjectId ?? ""));
      const { values: ids, bytes } = boundedPage(remaining, Math.min(pageSize, limit, nativeLimit));
      return { ids, nativeVisits: ids.length, nativeBytes: bytes, rowsRead: ids.length, bytesRead: bytes,
        truncated: ids.length < remaining.length, committedThrough: ids.at(-1) ?? afterObjectId };
    },
    source: ({ objectId, byteLimit }) => {
      const row = options.sources?.[objectId] ?? { object_id: objectId, sourceRevision: `rev-${objectId}`,
        lifecycle_state: "active", scope_class: "project" };
      const bytes = Buffer.byteLength(JSON.stringify(row), "utf8");
      if (bytes > (byteLimit ?? Infinity)) return { row: null, rowsRead: 0, bytesRead: 0, unavailable: false, resourceLimited: true };
      return { row, rowsRead: 1, bytesRead: bytes, unavailable: false };
    },
    sourceRoots: () => ({ rows: [], nativeVisits: 0, nativeBytes: 0, rowsRead: 0, bytesRead: 0, truncated: false }),
    relation: ({ subject, predicate, afterAssertionId, limit, nativeLimit, byteLimit }) => {
      const remaining = rows.filter((row) => row.sourceObjectId === subject && row.predicate === predicate
        && row.assertionId > (afterAssertionId ?? "")).sort((left, right) => left.assertionId.localeCompare(right.assertionId));
      const { values: observations, bytes } = boundedPage(remaining, Math.min(pageSize, limit, nativeLimit), byteLimit);
      return { observations, nativeVisits: observations.length, nativeBytes: bytes,
        rowsRead: observations.length, bytesRead: bytes, truncated: observations.length < remaining.length,
        committedThrough: observations.at(-1)?.assertionId ?? afterAssertionId };
    }
  };
}

function boundedPage<T>(rows: readonly T[], count: number, byteLimit = Infinity): { values: T[]; bytes: number } {
  const values: T[] = [];
  let bytes = 0;
  for (const row of rows.slice(0, count)) {
    const rowBytes = Buffer.byteLength(JSON.stringify(row), "utf8");
    if (bytes + rowBytes > byteLimit) break;
    values.push(row); bytes += rowBytes;
  }
  return { values, bytes };
}

/** Decodes actual bindings and actual proof alternatives; no finite expectation runs here. */
export function extractQualifiedResults(state: FieldEngineState, physicalOrigins: PhysicalOrigins): QualifiedResult[] {
  if (state.binding.kind !== "bound") throw new Error(`native field is ${state.binding.kind}`);
  if (state.pending_path_effects !== undefined || state.retention_rejected !== undefined || state.memory_exhausted ||
      ["interrupted", "unavailable", "invalidated", "cancelled"].includes(state.last_observer_status ?? "") ||
      state.closure.propagation !== "fixed_point" ||
      !state.binding.solver_complete) throw new Error("native observation or solver work is unfinished");
  const grounded = groundedOutputDerivations({ seeds: state.seeds, transitions: state.transitions,
    derivations: state.derivations, transition_derivations: state.transition_derivations,
    allowance: 1_000_000, memory_bytes: 64_000_000 });
  if (!grounded.complete) throw new Error("native output grounding is incomplete");
  const synthetic = syntheticLeaves(state);
  const forest = new Map(grounded.derivations.map((row) => [row.derivation_id, row]));
  const expand = createDerivationAlternativeExpander(forest, (row) => physicalLeafKeys(row, physicalOrigins, synthetic));
  return state.binding.snapshot.values.filter((row) => row.accepting && row.milligrades !== undefined).map((row) => {
    if (row.state.target.kind !== "memory_entry") throw new Error("finite fixture received a non-memory target");
    if (row.milligrades === undefined) throw new Error("finite fixture received an ungraded accepting value");
    const bindings = [...parseBindingContext(row.state.binding_context, state.binding_contexts)]
      .sort(([a], [b]) => a.localeCompare(b));
    const roots = grounded.roots[productStateNodeId(row.state)] ?? [];
    if (roots.length === 0 && row.milligrades > 0) throw new Error("positive accepting value has no grounded proof");
    return { anchor: bindings.find(([key]) => key === "x")?.[1] ?? null,
      target: row.state.target, hypothesis: row.state.hypothesis_id, bindings,
      time_state: row.state.time_state, grade: row.milligrades, cap_contract_id: row.cap_contract_id,
      supports: roots.flatMap((root) => expand(root).map((keys) => [...keys].sort())) };
  });
}

function physicalLeafKeys(row: Derivation, origins: PhysicalOrigins, synthetic: ReadonlyMap<string, Derivation>): string[] {
  if (row.children.length > 0) {
    if (row.provenance_layout !== "local_leaves.v1" || row.leaf_ids.length !== 0 || row.observation_ids.length !== 0
      || row.source_revisions.length !== 0) throw new Error("unexpected aggregate native provenance");
    return [];
  }
  if (row.kind !== "leaf" || row.leaf_ids.length !== 1 || row.observation_ids.length !== 1) {
    throw new Error("unexpected native leaf shape");
  }
  const leaf = row.leaf_ids[0]!, origin = origins.get(leaf);
  if (origin !== undefined) {
    if (row.observation_ids[0] !== leaf || row.source_revisions.length !== 1 || row.source_revisions[0] !== origin.revision) {
      throw new Error(`physical native leaf revision mismatch: ${leaf}`);
    }
    return [JSON.stringify([origin.id, origin.revision])];
  }
  const allowed = synthetic.get(row.derivation_id);
  if (allowed === undefined || JSON.stringify([row.leaf_ids, row.observation_ids, row.source_revisions]) !==
    JSON.stringify([allowed.leaf_ids, allowed.observation_ids, allowed.source_revisions])) {
    throw new Error(`unexpected native proof leaf: ${leaf}`);
  }
  return [];
}

/** Native seed IDs may be digests. Match exact IDs and payloads, never an unknown-leaf fallback. */
function syntheticLeaves(state: FieldEngineState): ReadonlyMap<string, Derivation> {
  const leaves = new Map<string, Derivation>();
  const starts = new Set<string>();
  const visit = (program: QueryProgram): void => {
    for (const start of compileProgramAutomaton(program).start) starts.add(start);
    if (program.kind === "sequence") program.steps.forEach(visit);
    else if (program.kind === "alternative") program.options.forEach(visit);
    else if (program.kind === "hyperedge") program.premises.forEach(visit);
    else if (program.kind === "repeat" || program.kind === "closure") visit(program.body);
  };
  visit(state.interpretation.program);
  const add = (product: ProductStateKey): void => {
    const id = seedDerivationIdentity(productStateNodeId(product));
    leaves.set(id, leafDerivation({ derivation_id: id, leaf_id: id, observation_id: productEndpointId(product),
      source_revision: product.target.kind === "memory_entry" ? product.target.source_revision : product.target.source_version }));
    const epsilon = `${productEndpointId(product)}:${productEndpointId(product)}:epsilon`;
    const row = leafDerivation({ derivation_id: `leaf:${epsilon}`, leaf_id: epsilon, observation_id: epsilon });
    leaves.set(row.derivation_id, row);
  };
  for (const product of state.seen_identities) {
    add(product);
    for (const program_state of starts) add({ ...product, program_state });
  }
  for (const seed of state.seeds) add(seed.state);
  return leaves;
}
