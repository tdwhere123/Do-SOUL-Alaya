import type { RecallQueryProbes } from "./recall-query-probes.js";
import { splitLexicalTokens } from "./recall-query-probes.js";

export type RecallQueryDemandKind =
  | "ordering"
  | "temporal"
  | "lexical_term"
  | "phrase"
  | "object_id"
  | "evidence_ref"
  | "dimension"
  | "scope_class"
  | "domain_tag";

export type RecallQueryDemandPriority = "core" | "supporting";

export interface RecallQueryDemandAtom {
  readonly id: string;
  readonly kind: RecallQueryDemandKind;
  readonly value: string;
  readonly priority: RecallQueryDemandPriority;
}

export interface RecallQueryDemand {
  readonly schema_version: 1;
  readonly atoms: readonly Readonly<RecallQueryDemandAtom>[];
}

export interface CompileRecallQueryDemandOptions {
  readonly sourceExactLexicalTerms?: readonly string[];
}

export function compileRecallQueryDemand(
  probes: Readonly<RecallQueryProbes>,
  options: Readonly<CompileRecallQueryDemandOptions> = {}
): Readonly<RecallQueryDemand> {
  const text = probes.normalized_query ?? "";
  const atoms = [
    ...orderingAtoms(text),
    ...probes.date_terms.map((term) => demandAtom("temporal", normalize(term), "core")),
    ...lexicalDemandAtoms(probes),
    ...sourceExactLexicalDemandAtoms(options.sourceExactLexicalTerms ?? []),
    ...structuralDemandAtoms(probes)
  ];
  return freezeDemand(atoms);
}

export function extendRecallQueryDemandWithSourceExactLexicalTerms(
  demand: Readonly<RecallQueryDemand>,
  terms: readonly string[]
): Readonly<RecallQueryDemand> {
  if (demand.schema_version !== 1) {
    throw new Error("recall query demand schema mismatch");
  }
  return freezeDemand([
    ...demand.atoms,
    ...sourceExactLexicalDemandAtoms(terms)
  ]);
}

function freezeDemand(
  atoms: readonly Readonly<RecallQueryDemandAtom>[]
): Readonly<RecallQueryDemand> {
  const unique = new Map(atoms.map((atom) => [atom.id, atom]));
  return Object.freeze({
    schema_version: 1,
    atoms: Object.freeze([...unique.values()])
  });
}

function sourceExactLexicalDemandAtoms(
  terms: readonly string[]
): readonly RecallQueryDemandAtom[] {
  return terms.flatMap((term) => {
    const normalized = normalize(term);
    return normalized.length === 0
      ? []
      : [demandAtom("lexical_term", normalized, "supporting")];
  });
}

function structuralDemandAtoms(
  probes: Readonly<RecallQueryProbes>
): readonly RecallQueryDemandAtom[] {
  return [
    ...probes.phrases.map((value) =>
      demandAtom("phrase", normalize(value), "supporting")),
    ...probes.object_ids.map((value) => demandAtom("object_id", normalize(value), "core")),
    ...probes.evidence_refs.map((value) => demandAtom("evidence_ref", normalize(value), "core")),
    ...probes.dimensions.map((value) => demandAtom("dimension", normalize(value), "supporting")),
    ...probes.scope_classes.map((value) => demandAtom("scope_class", normalize(value), "supporting")),
    ...probes.domain_tags.map((value) => demandAtom("domain_tag", normalize(value), "supporting"))
  ];
}

function orderingAtoms(text: string): readonly RecallQueryDemandAtom[] {
  if (/\b(?:in what order|what order|sequence)\b/iu.test(text)) {
    return [demandAtom("ordering", "sequence", "core")];
  }
  if (/\b(?:earliest|first)\b/iu.test(text)) {
    return [demandAtom("ordering", "earliest", "core")];
  }
  if (/\b(?:latest|most recent(?:ly)?)\b/iu.test(text)) {
    return [demandAtom("ordering", "latest", "core")];
  }
  return [];
}

function lexicalDemandAtoms(
  probes: Readonly<RecallQueryProbes>
): readonly RecallQueryDemandAtom[] {
  const temporalTokens = new Set(probes.date_terms.flatMap(splitLexicalTokens));
  return probes.lexical_terms.flatMap((term) => {
    const normalized = normalize(term);
    return temporalTokens.has(normalized)
      ? []
      : [demandAtom("lexical_term", normalized, "supporting")];
  });
}

function demandAtom(
  kind: RecallQueryDemandKind,
  value: string,
  priority: RecallQueryDemandPriority
): Readonly<RecallQueryDemandAtom> {
  return Object.freeze({ id: `${kind}:${value}`, kind, value, priority });
}

function normalize(value: string): string {
  return value.trim().replace(/[.]+$/u, "").replace(/\s+/gu, " ").toLocaleLowerCase();
}
