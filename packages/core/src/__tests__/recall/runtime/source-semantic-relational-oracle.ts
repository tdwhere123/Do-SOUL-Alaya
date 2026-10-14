import type { SourceSemanticCorrespondence, SourceSemanticConsumedLeaf, SourceSemanticInterpretation,
  SourceSemanticQuery, SourceSemanticReasoningResult } from "@do-soul/alaya-protocol";
import { semanticAssignmentProofs, semanticLeafKey } from "./source-semantic-oracle-obligations.js";
import { createDerivationAlternativeExpander } from "../conditional-field/evidence/derivation-alternatives.oracle.js";

export type SourceSemanticOracleAssignment = Readonly<{ bindings: Readonly<Record<string, string>>; leaves: readonly SourceSemanticConsumedLeaf[] }>;
export type SourceSemanticOracleResult = Readonly<{ assignments: readonly SourceSemanticOracleAssignment[] }>;
export const leafKey = semanticLeafKey;

/** Enumerates typed assignments independently of production compilation, paths and normalizers. */
export function oracleSourceSemanticJoin(interpretation: SourceSemanticInterpretation, semantics: SourceSemanticQuery, correspondence: SourceSemanticCorrespondence): SourceSemanticOracleResult {
  const assignments: SourceSemanticOracleAssignment[] = [];
  for (const [alt, branch] of semantics.alternatives.entries()) {
    const used = new Set(branch.frames.flatMap((row) => [row.variable, ...row.role_requirements.map((role) => role.target_variable)]));
    const variables = semantics.variables.filter((row) => used.has(row.id));
    const domains = variables.map((variable) => variable.sort === "entity"
      ? interpretation.referents.filter((r) => r.referent_kind === "grouped" || r.referent_kind === "unexpressed").map((row) => row.id)
      : variable.sort === "proposition" ? interpretation.frames.map((row) => row.id) : interpretation.operators.map((row) => row.id));
    let visits = 0;
    for (const values of cartesian(domains)) {
      if (++visits > 100000) throw new Error("independent oracle assignment bound exceeded");
      const bindings = Object.fromEntries(variables.map((row, index) => [row.id, values[index]!]));
      for (const leaves of semanticAssignmentProofs(interpretation, semantics, correspondence, branch, alt, bindings)) assignments.push({ bindings, leaves });
    }
  }
  return { assignments };
}
function* cartesian(groups: readonly (readonly string[])[], prefix: string[] = []): Generator<string[]> {
  if (prefix.length === groups.length) { yield prefix; return; }
  for (const value of groups[prefix.length]!) yield* cartesian(groups, [...prefix, value]);
}
/** The public result, not source interpretation and semantic correspondence, supplies every decoded binding. */
export function decodeEngineBindings(result: SourceSemanticReasoningResult): readonly Readonly<Record<string, string>>[] {
  if (result.binding_results === undefined) throw new Error("reason result did not expose actual engine bindings");
  return result.binding_results.map((answer) => Object.fromEntries(Object.entries(answer.bindings).map(([key, coordinate]) => [key, coordinate.node_id])));
}
export function assignmentBindings(assignment: SourceSemanticOracleAssignment, variables: readonly string[]): Record<string, string> {
  return Object.fromEntries(variables.filter((key) => assignment.bindings[key] !== undefined).map((key) => [key, assignment.bindings[key]!]));
}
export function oracleBindingsMatchEngine(oracle: SourceSemanticOracleResult, decoded: readonly Readonly<Record<string, string>>[], variables: readonly string[]): boolean {
  const key = (bindings: Readonly<Record<string, string>>) => JSON.stringify(variables.map((id) => [id, bindings[id] ?? ""]));
  const left = new Set(oracle.assignments.map((row) => key(row.bindings))), right = new Set(decoded.map(key));
  return left.size === right.size && [...left].every((value) => right.has(value));
}
/** Compare exact leaves of each actual proof against independent assignment obligations. */
export function oracleProofsMatchEngine(oracle: SourceSemanticOracleResult, result: SourceSemanticReasoningResult): boolean {
  const rows = new Map((result.derivations ?? []).map((row) => [row.derivation_id, row]));
  const leaves = new Map((result.evidence_leaves ?? []).map((row) => [row.observation_id, row.leaf]));
  const expand = createDerivationAlternativeExpander(rows, (row) =>
    row.observation_ids.flatMap((key) => leaves.has(key) ? [leafKey(leaves.get(key)!)] : []));
  const bindingKey = (bindings: Readonly<Record<string, string>>) => JSON.stringify(Object.entries(bindings).sort(([a], [b]) => a.localeCompare(b)));
  for (const answer of result.binding_results ?? []) {
    const binding = Object.fromEntries(Object.entries(answer.bindings).map(([key, value]) => [key, value.node_id]));
    const expected = oracle.assignments.filter((row) => bindingKey(row.bindings) === bindingKey(binding));
    if (expected.length === 0 || answer.explanation_ids.length === 0) return false;
    for (const root of answer.explanation_ids) for (const proof of expand(root)) {
      if (!expected.some((row) => { const keys = new Set(row.leaves.map(leafKey)); return keys.size === proof.size && [...keys].every((key) => proof.has(key)); })) return false;
    }
  }
  return oracle.assignments.length !== 0 || (result.binding_results?.length === 0 && result.consumed_leaves.length === 0);
}
export function oracleNecessaryLeavesHeld(oracle: SourceSemanticOracleResult, engineLeaves: readonly SourceSemanticConsumedLeaf[]): boolean {
  if (oracle.assignments.length === 0) return engineLeaves.length === 0;
  const keys = new Set(engineLeaves.map(leafKey));
  return oracle.assignments.every((row) => row.leaves.every((leaf) => keys.has(leafKey(leaf))));
}
