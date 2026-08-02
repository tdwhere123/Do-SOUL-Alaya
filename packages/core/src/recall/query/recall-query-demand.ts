import type { RecallQueryProbes } from "./recall-query-probes.js";
import { splitLexicalTokens } from "./recall-query-probes.js";
import {
  isRecallQueryOperatorTerm,
  isRecallQueryRelationTerm
} from "./demand/query-term-role.js";

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

const ASSISTANT_SOURCE =
  /\b(?:you|your)\b.{0,48}\b(?:recommended|suggested|said|told|mentioned|advised|provided|shared)\b|\bdid\s+you\b.{0,48}\b(?:recommend|suggest|say|tell|mention|advise|provide|share)\b/iu;
const USER_SOURCE =
  /\bi\b.{0,48}\b(?:ask(?:ed)?|say|said|tell|told|mention(?:ed)?|share(?:d)?|spend|spent|travel(?:ed)?|visit(?:ed)?|buy|bought|choose|chose|take|took|use(?:d)?|attend(?:ed)?)\b/iu;
const PERSONAL_CONTEXT =
  /\b(?:i|me|my|mine|myself)\b|\b(?:for|to)\s+me\b|我|我的|适合我/iu;
const PROSPECTIVE_RECOMMENDATION =
  /\b(?:can|could|would)\s+you\s+(?:please\s+)?(?:recommend|suggest|advise)\b|\bwhat\s+should\s+i\b|\bany\s+(?:recommendations?|suggestions?|tips|advice)\b|\b(?:recommendations?|suggestions?|tips|advice)\s+(?:for|to)\s+me\b|(?:推荐|建议).{0,16}(?:给我|适合我)/iu;

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
    ...probes.phrases
      .filter(isInformativePhrase)
      .map((value) => demandAtom("phrase", normalize(value), "supporting")),
    ...probes.object_ids.map((value) => demandAtom("object_id", normalize(value), "core")),
    ...probes.evidence_refs.map((value) => demandAtom("evidence_ref", normalize(value), "core")),
    ...probes.dimensions.map((value) => demandAtom("dimension", normalize(value), "supporting")),
    ...probes.scope_classes.map((value) => demandAtom("scope_class", normalize(value), "supporting")),
    ...probes.domain_tags.map((value) => demandAtom("domain_tag", normalize(value), "supporting")),
    ...soughtFacets.map((value) => demandAtom("facet", normalize(value), "supporting"))
  ];
}

function isInformativePhrase(value: string): boolean {
  return splitLexicalTokens(value).some((term) =>
    !isRecallQueryOperatorTerm(term) && !isRecallQueryRelationTerm(term)
  );
}

function answerSlotAtoms(text: string): readonly RecallQueryDemandAtom[] {
  if (isProspectivePersonalRecommendation(text)) {
    return [demandAtom("answer_slot", "recommendation", "core")];
  }
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
  if (ASSISTANT_SOURCE.test(text) || /你.{0,16}(?:建议过|推荐过|说过|提到过|曾建议|曾推荐)/u.test(text)) {
    atoms.push(demandAtom("source_role", "assistant", "core"));
  }
  if (USER_SOURCE.test(text) || /我.{0,16}(?:说过|提到|买|去过|花了)/u.test(text)) {
    atoms.push(demandAtom("source_role", "user", "core"));
  }
  if (isProspectivePersonalRecommendation(text)) {
    atoms.push(demandAtom("source_role", "user", "core"));
  }
  return atoms;
}

function isProspectivePersonalRecommendation(text: string): boolean {
  return !ASSISTANT_SOURCE.test(text) &&
    PERSONAL_CONTEXT.test(text) &&
    PROSPECTIVE_RECOMMENDATION.test(text);
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
    if (isRecallQueryOperatorTerm(normalized) || temporalTokens.has(normalized)) return [];
    const kind = isRecallQueryRelationTerm(normalized) ? "relation" : "target";
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
  return value.trim().replace(/[.]+$/u, "").replace(/\s+/gu, " ").toLocaleLowerCase();
}
