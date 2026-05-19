import { MemoryDimension, ScopeClass, type MemoryDimension as MemoryDimensionType, type ScopeClass as ScopeClassType } from "@do-soul/alaya-protocol";

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
      phrases: [],
      char_ngrams: [],
      date_terms: []
    });
  }

  const lexicalTerms = extractLexicalTerms(normalized);
  return freezeProbes({
    normalized_query: normalized,
    subject_hints: inferSubjectHints(normalized),
    object_ids: collectMatches(normalized, /\b(?:memory|mem|object|obj)[_-]?([a-z0-9][a-z0-9_-]{5,})\b/giu),
    evidence_refs: collectMatches(normalized, /\b(?:evidence|ev|ref)[_-]?([a-z0-9][a-z0-9_.:-]{3,})\b/giu),
    run_ids: collectFullMatches(normalized, /\brun[-_][a-z0-9][a-z0-9_-]*\b/giu),
    surface_ids: collectFullMatches(normalized, /\bsurface[-_][a-z0-9][a-z0-9_-]*\b/giu),
    file_paths: collectFullMatches(normalized, /(?:^|\s)(?:\.{1,2}\/|\/)?[\w.-]+(?:\/[\w .-]+)+/giu).map((value) => value.trim()),
    command_names: collectFullMatches(normalized, /`([^`]{2,80})`/giu),
    package_names: collectFullMatches(normalized, /@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|(?:[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:\.js|\.ts|\.mjs)?/giu)
      .filter((value) => value.includes("/") || value.startsWith("@")),
    task_refs: collectFullMatches(normalized, /\b(?:#|bl-|task-|v\d+\.\d+\.\d+)[a-z0-9_.-]*\b/giu),
    dimensions: DIMENSION_HINTS.flatMap(([dimension, pattern]) => pattern.test(normalized) ? [dimension] : []),
    scope_classes: inferScopeClasses(normalized),
    domain_tags: DOMAIN_HINTS.flatMap(([tag, pattern]) => pattern.test(normalized) ? [tag] : []),
    lexical_terms: lexicalTerms,
    phrases: extractPhrases(normalized, lexicalTerms),
    char_ngrams: extractCharNgrams(normalized),
    date_terms: collectFullMatches(
      normalized,
      /\b\d{4}-\d{2}(?:-\d{2})?\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b(?:today|yesterday|tomorrow|tonight|last\s+(?:week|month|year)|next\s+(?:week|month|year)|this\s+(?:week|month|year))\b|(?:上次|昨天|今天|明天|今晚|上周|上个月|去年|下周|下个月|明年|今年|\d{4}年\d{1,2}月(?:\d{1,2}日)?)/giu
    )
  });
}

function normalizeQuery(queryText: string | null): string | null {
  const trimmed = queryText?.trim() ?? "";
  return trimmed.length === 0 ? null : trimmed;
}

function extractLexicalTerms(value: string): readonly string[] {
  const terms = value
    .split(/[^\p{L}\p{N}_./@#-]+/u)
    .map((term) => term.trim().toLocaleLowerCase())
    .filter((term) => term.length > 0)
    .filter((term) => !STOP_WORDS.has(term))
    .filter((term) => term.length > 2 || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(term));
  return unique(terms).slice(0, 48);
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
    phrases: Object.freeze([...probes.phrases]),
    char_ngrams: Object.freeze([...probes.char_ngrams]),
    date_terms: Object.freeze([...probes.date_terms])
  });
}
