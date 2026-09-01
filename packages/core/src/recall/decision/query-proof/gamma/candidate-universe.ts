import { compareText } from "../../../../shared/compare-text.js";
import type { QueryCompiledGammaV1 } from "./contract.js";

export function firstDuplicate(values: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return null;
}

export function compiledGammaUniverseMismatch(
  compileKeys: readonly string[],
  compiled: QueryCompiledGammaV1
): string | null {
  if (firstDuplicate(compileKeys) !== null) {
    return "duplicate compile-input candidate_key";
  }
  if (firstDuplicate(compiled.atoms.map((atom) => atom.atom_id)) !== null) {
    return "duplicate gamma atom identity";
  }
  const feasibilityKeys = compiled.semantic_feasibility.map((row) => row.candidate_key);
  if (firstDuplicate(feasibilityKeys) !== null) {
    return "duplicate compiled feasibility candidate_key";
  }
  const standingPairs = compiled.standings.map((row) =>
    `${row.candidate_key}\0${row.atom_id}`);
  if (firstDuplicate(standingPairs) !== null) {
    return "duplicate compiled standing";
  }
  if (!sameSorted(compileKeys, feasibilityKeys)) {
    return "compiled feasibility is not one row per compile-input candidate";
  }
  const standings = new Set(standingPairs);
  const atomIds = compiled.atoms.map((atom) => atom.atom_id);
  const atomSet = new Set(atomIds);
  const compileSet = new Set(compileKeys);
  for (const standing of compiled.standings) {
    if (!compileSet.has(standing.candidate_key)) {
      return "standing candidate is outside universe";
    }
    if (!atomSet.has(standing.atom_id)) {
      return "standing atom is outside compiled atoms";
    }
  }
  if (compiled.standings.length !== compileKeys.length * compiled.atoms.length) {
    return "compiled standings are not one row per candidate atom";
  }
  for (const key of compileKeys) {
    for (const atomId of atomIds) {
      if (!standings.has(`${key}\0${atomId}`)) {
        return "compiled standings are not one row per candidate atom";
      }
    }
  }
  return null;
}

export function decideWorldUniverseMismatch(
  compileKeys: readonly string[],
  worldKeys: readonly string[],
  compiled: QueryCompiledGammaV1
): string | null {
  if (firstDuplicate(compileKeys) !== null) {
    return "duplicate compile-input candidate_key";
  }
  if (firstDuplicate(worldKeys) !== null) {
    return "duplicate world candidate_key";
  }
  if (!sameSorted(compileKeys, worldKeys)) {
    return "compile-input, compiled feasibility, and world candidate universes differ";
  }
  if (compiled.compile_status !== "compiled") return null;
  return compiledGammaUniverseMismatch(compileKeys, compiled);
}

export function projectCompiledToCandidateKeys(
  compiled: QueryCompiledGammaV1,
  keys: readonly string[]
): QueryCompiledGammaV1 {
  const allowed = new Set(keys);
  return Object.freeze({
    ...compiled,
    standings: Object.freeze(
      compiled.standings.filter((row) => allowed.has(row.candidate_key))
    ),
    semantic_feasibility: Object.freeze(
      compiled.semantic_feasibility.filter((row) => allowed.has(row.candidate_key))
    )
  });
}

function sameSorted(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort(compareText);
  const sortedRight = [...right].sort(compareText);
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}
