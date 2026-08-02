import type { RecallQueryProbes } from "./recall-query-probes.js";
import { splitLexicalTokens } from "./recall-query-probes.js";

export type RecallQueryDemandKind =
  | "answer_slot"
  | "source_role"
  | "ordering"
  | "temporal"
  | "target"
  | "relation"
  | "phrase"
  | "object_id"
  | "evidence_ref"
  | "dimension"
  | "scope_class"
  | "domain_tag"
  | "facet";

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
  readonly soughtFacets?: readonly string[];
}

const OPERATOR_TERMS = new Set([
  "about", "again", "been", "being", "could", "current", "did", "does",
  "earliest", "first", "from", "have", "into", "last", "latest", "long",
  "many", "most", "much", "order", "previous", "recently", "remind", "specific",
  "that", "their", "there", "these", "they", "this", "those", "total", "what",
  "when", "where", "which", "while", "with", "would", "your"
]);

const RELATION_TERMS = new Set([
  "ask", "asked", "attend", "attended", "bought", "buy", "choose", "chose",
  "decide", "decided", "gave", "give", "learn", "learned", "like", "liked",
  "mention", "mentioned", "met", "move", "moved", "own", "paid", "pay",
  "prefer", "preferred", "provide", "provided", "recommend", "recommended",
  "say", "said", "share", "shared", "spend", "spent", "suggest", "suggested",
  "tell", "told", "travel", "traveled", "visit", "visited", "watch", "watched"
]);

const ASSISTANT_SOURCE =
  /\b(?:you|your)\b.{0,48}\b(?:recommend(?:ed)?|suggest(?:ed)?|say|said|tell|told|mention(?:ed)?|advise(?:d)?|provide(?:d)?|share(?:d)?)\b/iu;
const USER_SOURCE =
  /\bi\b.{0,48}\b(?:ask(?:ed)?|say|said|tell|told|mention(?:ed)?|share(?:d)?|spend|spent|travel(?:ed)?|visit(?:ed)?|buy|bought|choose|chose)\b/iu;

export function compileRecallQueryDemand(
  probes: Readonly<RecallQueryProbes>,
  options: Readonly<CompileRecallQueryDemandOptions> = {}
): Readonly<RecallQueryDemand> {
  const text = probes.normalized_query ?? "";
  const atoms = [
    ...answerSlotAtoms(text),
    ...sourceRoleAtoms(text),
    ...orderingAtoms(text),
    ...probes.date_terms.map((term) => demandAtom("temporal", normalize(term), "core")),
    ...lexicalDemandAtoms(probes),
    ...structuralDemandAtoms(probes, options.soughtFacets ?? [])
  ];
  const unique = new Map(atoms.map((atom) => [atom.id, atom]));
  return Object.freeze({
    schema_version: 1,
    atoms: Object.freeze([...unique.values()])
  });
}

function structuralDemandAtoms(
  probes: Readonly<RecallQueryProbes>,
  soughtFacets: readonly string[]
): readonly RecallQueryDemandAtom[] {
  return [
    ...probes.phrases.map((value) => demandAtom("phrase", normalize(value), "supporting")),
    ...probes.object_ids.map((value) => demandAtom("object_id", normalize(value), "core")),
    ...probes.evidence_refs.map((value) => demandAtom("evidence_ref", normalize(value), "core")),
    ...probes.dimensions.map((value) => demandAtom("dimension", normalize(value), "supporting")),
    ...probes.scope_classes.map((value) => demandAtom("scope_class", normalize(value), "supporting")),
    ...probes.domain_tags.map((value) => demandAtom("domain_tag", normalize(value), "supporting")),
    ...soughtFacets.map((value) => demandAtom("facet", normalize(value), "supporting"))
  ];
}

function answerSlotAtoms(text: string): readonly RecallQueryDemandAtom[] {
  if (/\bhow long\b/iu.test(text)) return [demandAtom("answer_slot", "duration", "core")];
  if (/\bhow many\b/iu.test(text)) return [demandAtom("answer_slot", "count", "core")];
  if (/\bhow much\b/iu.test(text)) return [demandAtom("answer_slot", "amount", "core")];
  if (/\bwho\b|谁/u.test(text)) return [demandAtom("answer_slot", "person", "core")];
  if (/\bwhere\b|哪里|哪儿/u.test(text)) return [demandAtom("answer_slot", "place", "core")];
  if (/\bwhen\b|何时|什么时候/u.test(text)) return [demandAtom("answer_slot", "time", "core")];
  if (/\bwhich\b/iu.test(text)) return [demandAtom("answer_slot", "choice", "core")];
  if (/\bwhat\b.{0,32}\bname\b|\bname\b.{0,32}\bwhat\b/iu.test(text)) {
    return [demandAtom("answer_slot", "name", "core")];
  }
  return /\bwhat\b|\bremind me\b|什么/iu.test(text)
    ? [demandAtom("answer_slot", "fact", "core")]
    : [];
}

function sourceRoleAtoms(text: string): readonly RecallQueryDemandAtom[] {
  const atoms: RecallQueryDemandAtom[] = [];
  if (ASSISTANT_SOURCE.test(text) || /你.{0,16}(?:建议|推荐|说过|提到)/u.test(text)) {
    atoms.push(demandAtom("source_role", "assistant", "core"));
  }
  if (USER_SOURCE.test(text) || /我.{0,16}(?:说过|提到|买|去过|花了)/u.test(text)) {
    atoms.push(demandAtom("source_role", "user", "core"));
  }
  return atoms;
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
    if (OPERATOR_TERMS.has(normalized) || temporalTokens.has(normalized)) return [];
    const kind = RELATION_TERMS.has(normalized) ? "relation" : "target";
    return [demandAtom(kind, normalized, "supporting")];
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
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}
