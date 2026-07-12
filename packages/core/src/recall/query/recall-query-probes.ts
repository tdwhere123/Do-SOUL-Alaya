import { MemoryDimension, ScopeClass, type MemoryDimension as MemoryDimensionType, type ScopeClass as ScopeClassType } from "@do-soul/alaya-protocol";
import { extractTemporalTerms } from "@do-soul/alaya-graph-algorithms";
import { recallEnvRaw } from "../../config/recall-env-access.js";
import { isCjkSegmentationCandidate, segmentCjkRun } from "../../shared/cjk-segmentation.js";

export type RecallQuerySubjectHint = "self_reference";

export interface RecallQueryProbes {
  readonly normalized_query: string | null;
  readonly subject_hints: readonly RecallQuerySubjectHint[];
  readonly object_ids: readonly string[];
  readonly evidence_refs: readonly string[];
  readonly run_ids: readonly string[];
  readonly surface_ids: readonly string[];
  readonly file_paths: readonly string[];
  readonly command_names: readonly string[];
  readonly package_names: readonly string[];
  readonly task_refs: readonly string[];
  readonly dimensions: readonly MemoryDimensionType[];
  readonly scope_classes: readonly ScopeClassType[];
  readonly domain_tags: readonly string[];
  readonly lexical_terms: readonly string[];
  // Deterministic expansions (morphology, abbreviations, domain synonyms) kept distinct from lexical_terms so phrase adjacency / rerank tokenize off surface terms only; fed to FTS to widen coverage. see also: expandLexicalTerms.
  readonly expanded_terms: readonly string[];
  readonly phrases: readonly string[];
  readonly char_ngrams: readonly string[];
  readonly date_terms: readonly string[];
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "the",
  "to",
  "was",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
  "you",
  "your"
]);

const DIMENSION_HINTS: ReadonlyArray<readonly [MemoryDimensionType, RegExp]> = [
  [MemoryDimension.PREFERENCE, /\b(prefer|preference|like|style|偏好|喜欢|倾向)\b/iu],
  [MemoryDimension.PROCEDURE, /\b(procedure|process|workflow|steps?|how to|操作|流程|步骤)\b/iu],
  [MemoryDimension.DECISION, /\b(decision|decide|decided|choose|choice|agreed|决定|选择|确认)\b/iu],
  [MemoryDimension.HAZARD, /\b(hazard|risk|danger|warning|avoid|风险|危险|注意)\b/iu],
  [MemoryDimension.CONSTRAINT, /\b(constraint|must|never|required|rule|限制|必须|不能)\b/iu],
  [MemoryDimension.GLOSSARY, /\b(glossary|term|definition|means|术语|定义)\b/iu],
  [MemoryDimension.EPISODE, /\b(episode|session|yesterday|today|last time|上次|昨天|今天)\b/iu],
  [MemoryDimension.FACT, /\b(fact|remember|context|事实|记得|上下文)\b/iu]
];

const DOMAIN_HINTS: ReadonlyArray<readonly [string, RegExp]> = [
  ["benchmark", /\b(bench(?:mark)?|longmemeval|eval|kpi|recall@|r@5|跑分|评测)\b/iu],
  ["recall", /\b(recall|retrieval|candidate|召回|候选)\b/iu],
  ["embedding", /\b(embedding|vector|semantic|嵌入|向量)\b/iu],
  ["inspector", /\b(inspector|overview|graph|检查器)\b/iu],
  ["docs", /\b(docs?|readme|文档)\b/iu],
  ["test", /\b(test|vitest|coverage|测试)\b/iu],
  ["release", /\b(release|version|v\d+\.\d+|发布)\b/iu]
];

export function compileRecallQueryProbes(queryText: string | null): Readonly<RecallQueryProbes> {
  const normalized = normalizeQuery(queryText);
  if (normalized === null) {
    return buildEmptyRecallQueryProbes();
  }
  return buildRecallQueryProbes(normalized);
}

function buildEmptyRecallQueryProbes(): Readonly<RecallQueryProbes> {
  return freezeProbes({
    normalized_query: null,
    subject_hints: [],
    object_ids: [],
    evidence_refs: [],
    run_ids: [],
    surface_ids: [],
    file_paths: [],
    command_names: [],
    package_names: [],
    task_refs: [],
    dimensions: [],
    scope_classes: [],
    domain_tags: [],
    lexical_terms: [],
    expanded_terms: [],
    phrases: [],
    char_ngrams: [],
    date_terms: []
  });
}

function buildRecallQueryProbes(normalized: string): Readonly<RecallQueryProbes> {
  const lexicalTerms = extractLexicalTerms(normalized);
  return freezeProbes({
    normalized_query: normalized,
    subject_hints: inferSubjectHints(normalized),
    object_ids: collectMatches(normalized, /\b(?:memory|mem|object|obj)[_-]?([a-z0-9][a-z0-9_-]{5,})\b/giu),
    evidence_refs: collectMatches(normalized, /\b(?:evidence|ev|ref)[_-]?([a-z0-9][a-z0-9_.:-]{3,})\b/giu),
    run_ids: collectFullMatches(normalized, /\brun[-_][a-z0-9][a-z0-9_-]*\b/giu),
    surface_ids: collectFullMatches(normalized, /\bsurface[-_][a-z0-9][a-z0-9_-]*\b/giu),
    file_paths: collectFilePathMatches(normalized),
    command_names: collectFullMatches(normalized, /`([^`]{2,80})`/giu),
    package_names: collectPackageNameMatches(normalized),
    task_refs: collectFullMatches(normalized, /\b(?:#|bl-|task-|v\d+\.\d+\.\d+)[a-z0-9_.-]*\b/giu),
    dimensions: collectDimensionHints(normalized),
    scope_classes: inferScopeClasses(normalized),
    domain_tags: collectDomainHints(normalized),
    lexical_terms: lexicalTerms,
    expanded_terms: expandLexicalTerms(lexicalTerms),
    phrases: extractPhrases(normalized, lexicalTerms),
    char_ngrams: extractCharNgrams(normalized),
    date_terms: extractTemporalTerms(normalized)
  });
}

function collectFilePathMatches(normalized: string): readonly string[] {
  return collectFullMatches(
    normalized,
    /(?:^|\s)(?:\.{1,2}\/|\/)?[\w.-]+(?:\/[\w .-]+)+/giu
  ).map((value) => value.trim());
}

function collectPackageNameMatches(normalized: string): readonly string[] {
  return collectFullMatches(
    normalized,
    /@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|(?:[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:\.js|\.ts|\.mjs)?/giu
  ).filter((value) => value.includes("/") || value.startsWith("@"));
}

function collectDimensionHints(normalized: string): readonly MemoryDimensionType[] {
  return DIMENSION_HINTS.flatMap(([dimension, pattern]) =>
    pattern.test(normalized) ? [dimension] : []
  );
}

function collectDomainHints(normalized: string): readonly string[] {
  return DOMAIN_HINTS.flatMap(([tag, pattern]) => pattern.test(normalized) ? [tag] : []);
}

function normalizeQuery(queryText: string | null): string | null {
  const trimmed = queryText?.trim() ?? "";
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Deterministic lowercased terms (shared split regex, length>2-or-CJK keep rule); keeps stop words. Reused by the feature-rerank tokenizer so query and candidate tokenize identically.
 * invariant: a CJK-bearing surface token yields its surface chunk first then deduped jieba word-pieces — keeps trigram substring coverage while exposing word boundaries. see also: shared/cjk-segmentation.ts.
 */
export function splitLexicalTokens(value: string): readonly string[] {
  const surfaceTokens = value
    .split(/[^\p{L}\p{N}_./@#-]+/u)
    .map((term) => term.trim().toLocaleLowerCase())
    .filter((term) => term.length > 0)
    .filter((term) => term.length > 2 || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(term));
  // invariant: surface tokens keep their duplicates so downstream occurrence-count features keep pre-jieba numerator behaviour; only jieba pieces are deduped against the output.
  const output: string[] = [];
  const seenJiebaPieces = new Set<string>();
  for (const token of surfaceTokens) {
    output.push(token);
    seenJiebaPieces.add(token);
    if (!isCjkSegmentationCandidate(token)) {
      continue;
    }
    for (const piece of segmentCjkRun(token)) {
      const normalized = piece.trim().toLocaleLowerCase();
      if (normalized.length === 0 || seenJiebaPieces.has(normalized)) {
        continue;
      }
      // invariant: only CJK-bearing jieba pieces enter lexical_terms; emitting jieba's ASCII pieces would split compound tokens (`admin_passwords你好`) and bypass surface-boundary integrity, so ASCII pieces are discarded.
      if (
        /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(normalized)
      ) {
        output.push(normalized);
        seenJiebaPieces.add(normalized);
      }
    }
  }
  return output;
}

function extractLexicalTerms(value: string): readonly string[] {
  const terms = splitLexicalTokens(value).filter((term) => !STOP_WORDS.has(term));
  return unique(terms).slice(0, 48);
}

// Conservative bidirectional synonym/abbreviation clusters keep product vocabulary aligned.
const DOMAIN_SYNONYM_CLUSTERS: ReadonlyArray<readonly string[]> = [
  ["alaya", "do-soul"],
  ["recall", "retrieval", "retrieve"],
  ["candidate", "candidates"],
  ["embedding", "embeddings", "vector", "vectors"],
  ["benchmark", "benchmarks", "bench"],
  ["longmemeval", "lme"],
  ["config", "configuration", "settings"],
  ["doc", "docs", "documentation"],
  ["repo", "repository"],
  ["dependency", "dependencies", "deps"],
  ["database", "db"],
  ["directory", "directories", "folder", "folders"],
  ["delete", "deletion", "remove", "removal"],
  ["create", "creation"],
  ["update", "modification", "modify"],
  ["error", "errors", "failure", "failures"]
];

const SYNONYM_CLUSTER_MAX_MEMBERS = 8;
const SYNONYM_CLUSTER_MAX_TOTAL = 256;

// Optional operator clusters (ALAYA_RECALL_EXTRA_SYNONYM_CLUSTERS, JSON array of string arrays); fail-loud on malformed JSON so a typo cannot silently disable expansion.
function readExtraSynonymClusters(): ReadonlyArray<readonly string[]> {
  const raw = recallEnvRaw("ALAYA_RECALL_EXTRA_SYNONYM_CLUSTERS");
  if (raw === undefined || raw.trim() === "") {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `ALAYA_RECALL_EXTRA_SYNONYM_CLUSTERS must be valid JSON: ${String(error)}`
    );
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every(
      (cluster) =>
        Array.isArray(cluster) &&
        cluster.every((member) => typeof member === "string")
    )
  ) {
    throw new Error(
      "ALAYA_RECALL_EXTRA_SYNONYM_CLUSTERS must be a JSON array of string arrays"
    );
  }
  return (parsed as readonly (readonly string[])[]).map((cluster) =>
    cluster
      .map((member) => member.trim().toLocaleLowerCase())
      .filter((member) => member.length > 0)
  );
}

// term -> sorted unique cluster partners; caps enforced at build time so an over-broad table fails loud at boot rather than degrading recall silently.
export function buildSynonymExpansionTable(): ReadonlyMap<string, readonly string[]> {
  const clusters = [...DOMAIN_SYNONYM_CLUSTERS, ...readExtraSynonymClusters()];
  if (clusters.length > SYNONYM_CLUSTER_MAX_TOTAL) {
    throw new Error(
      `synonym cluster table exceeds ${SYNONYM_CLUSTER_MAX_TOTAL} clusters (${clusters.length})`
    );
  }
  const map = new Map<string, string[]>();
  for (const cluster of clusters) {
    if (cluster.length > SYNONYM_CLUSTER_MAX_MEMBERS) {
      throw new Error(
        `synonym cluster exceeds ${SYNONYM_CLUSTER_MAX_MEMBERS} members: ${cluster.join(",")}`
      );
    }
    for (const member of cluster) {
      const partners = cluster.filter((other) => other !== member);
      map.set(member, [...(map.get(member) ?? []), ...partners]);
    }
  }
  return new Map(
    [...map.entries()].map(([term, partners]) => [
      term,
      [...new Set(partners)].sort()
    ])
  );
}

const SYNONYM_EXPANSION_BY_TERM = buildSynonymExpansionTable();

/** Deterministic expansion of each term into morphology-folded variants + domain synonyms; pure (no ML/network/clock). Excludes the originals and stop words, so it is purely additive coverage. */
export function expandLexicalTerms(lexicalTerms: readonly string[]): readonly string[] {
  const surface = new Set(lexicalTerms);
  const expansions: string[] = [];
  for (const term of lexicalTerms) {
    for (const variant of foldMorphology(term)) {
      expansions.push(variant);
    }
    for (const synonym of SYNONYM_EXPANSION_BY_TERM.get(term) ?? []) {
      expansions.push(synonym);
    }
  }
  return unique(
    expansions
      .map((term) => term.toLocaleLowerCase())
      .filter((term) => term.length > 2 && !surface.has(term) && !STOP_WORDS.has(term))
  ).slice(0, 64);
}

// Conservative noun-plural folding; verb stemming remains owned by the FTS tokenizer.
function foldMorphology(term: string): readonly string[] {
  if (!/^[a-z][a-z'-]*$/u.test(term)) {
    return [];
  }
  const variants = new Set<string>();
  const addStem = (stem: string): void => {
    if (stem.length > 2 && stem !== term) {
      variants.add(stem);
    }
  };
  if (term.endsWith("ies") && term.length > 4) {
    addStem(`${term.slice(0, -3)}y`);
  } else if (/(?:sses|shes|ches|xes|zes)$/u.test(term)) {
    addStem(term.slice(0, -2));
  } else if (term.endsWith("s") && !term.endsWith("ss") && term.length > 3) {
    addStem(term.slice(0, -1));
  }
  // Only noun plural forms are generated; verb stemming belongs to the FTS tokenizer.
  if (!term.endsWith("s")) {
    if (/[^aeiou]y$/u.test(term)) {
      variants.add(`${term.slice(0, -1)}ies`);
    } else {
      variants.add(/(?:s|x|z|ch|sh)$/u.test(term) ? `${term}es` : `${term}s`);
    }
  }
  return [...variants];
}

function extractPhrases(value: string, lexicalTerms: readonly string[]): readonly string[] {
  const quoted = collectFullMatches(value, /"([^"]{2,120})"|'([^']{2,120})'|`([^`]{2,120})`/giu);
  const adjacent = lexicalTerms
    .slice(0, 12)
    .flatMap((term, index, source) => {
      const next = source[index + 1];
      return next === undefined ? [] : [`${term} ${next}`];
    });
  return unique([...quoted, ...adjacent]).slice(0, 24);
}

function extractCharNgrams(value: string): readonly string[] {
  const compact = Array.from(value.replace(/\s+/gu, "").toLocaleLowerCase());
  if (compact.length < 3) {
    return [];
  }
  const grams: string[] = [];
  for (let i = 0; i <= compact.length - 3 && grams.length < 64; i += 1) {
    grams.push(compact.slice(i, i + 3).join(""));
  }
  return unique(grams);
}

function inferScopeClasses(value: string): readonly ScopeClassType[] {
  const scopes: ScopeClassType[] = [];
  if (/\b(project|repo|workspace|项目|仓库)\b/iu.test(value)) scopes.push(ScopeClass.PROJECT);
  if (/\b(global|across projects|全局)\b/iu.test(value)) scopes.push(ScopeClass.GLOBAL_DOMAIN);
  if (/\b(core|always|默认)\b/iu.test(value)) scopes.push(ScopeClass.GLOBAL_CORE);
  return unique(scopes);
}

function inferSubjectHints(value: string): readonly RecallQuerySubjectHint[] {
  return /\b(?:i|me|my|mine|we|our|ours)\b|(?:我|我的|我们|咱们|咱)/iu.test(value)
    ? Object.freeze(["self_reference"] as const)
    : Object.freeze([]);
}

function collectMatches(value: string, pattern: RegExp): readonly string[] {
  const matches: string[] = [];
  for (const match of value.matchAll(pattern)) {
    const captured = match[1];
    if (captured !== undefined && captured.trim().length > 0) {
      matches.push(captured.trim());
    }
  }
  return unique(matches).slice(0, 64);
}

function collectFullMatches(value: string, pattern: RegExp): readonly string[] {
  const matches: string[] = [];
  for (const match of value.matchAll(pattern)) {
    const captured = [...match].slice(1).find((item) => item !== undefined && item.trim().length > 0);
    matches.push((captured ?? match[0]).trim());
  }
  return unique(matches).slice(0, 64);
}

function unique<T>(values: readonly T[]): readonly T[] {
  return [...new Set(values)];
}

function freezeProbes(probes: RecallQueryProbes): Readonly<RecallQueryProbes> {
  return Object.freeze({
    ...probes,
    subject_hints: Object.freeze([...probes.subject_hints]),
    object_ids: Object.freeze([...probes.object_ids]),
    evidence_refs: Object.freeze([...probes.evidence_refs]),
    run_ids: Object.freeze([...probes.run_ids]),
    surface_ids: Object.freeze([...probes.surface_ids]),
    file_paths: Object.freeze([...probes.file_paths]),
    command_names: Object.freeze([...probes.command_names]),
    package_names: Object.freeze([...probes.package_names]),
    task_refs: Object.freeze([...probes.task_refs]),
    dimensions: Object.freeze([...probes.dimensions]),
    scope_classes: Object.freeze([...probes.scope_classes]),
    domain_tags: Object.freeze([...probes.domain_tags]),
    lexical_terms: Object.freeze([...probes.lexical_terms]),
    expanded_terms: Object.freeze([...probes.expanded_terms]),
    phrases: Object.freeze([...probes.phrases]),
    char_ngrams: Object.freeze([...probes.char_ngrams]),
    date_terms: Object.freeze([...probes.date_terms])
  });
}
