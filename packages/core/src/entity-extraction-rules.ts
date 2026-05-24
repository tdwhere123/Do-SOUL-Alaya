/**
 * Rule-based query-time entity extraction.
 *
 * Entity extraction here is QUERY-TIME ONLY: a recall helper turns the raw
 * task surface text into a small list of entity candidates whose surface
 * forms are then used to widen lexical / graph seeding. It does NOT write
 * `memory_graph_edges`, does NOT influence propose/accept, and does NOT
 * decide durable truth (invariants §5/§6/§7). The port is intentionally
 * narrow so a later swap (NER, embedding clustering, …) is mechanical.
 *
 * Determinism: every signal is a pure regex / character-class predicate
 * over the raw query string. No clock, no network, no LLM. Same input →
 * byte-identical output.
 *
 * Cost ceiling: at most `maxEntities` (default 8) candidates per query,
 * sorted by confidence; the regex passes are O(query length).
 *
 * see also: packages/core/src/recall-service.ts collectEntityDerivedSeeds
 * see also: packages/core/src/recall-query-probes.ts splitLexicalTokens
 */

import type { EntityCandidate, EntityExtractionPort } from "./entity-extraction-port.js";
export type { EntityCandidate, EntityExtractionPort } from "./entity-extraction-port.js";

const DEFAULT_MAX_ENTITIES = 8;
const MIN_NORMALIZED_LENGTH = 2;
const LONG_TOKEN_MIN_LENGTH = 4;

// Short, conservative stop-list shared with the query-probe lexical layer.
// Anything matched here is dropped from the unknown / long-token lane so a
// query like "what is the configured backup path" does not seed FTS with
// "what" / "configured".
const ENTITY_STOP_WORDS: ReadonlySet<string> = new Set([
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
  "your",
  "this",
  "that",
  "these",
  "those",
  "do",
  "does",
  "did"
]);

// Per-kind confidence floors. The numbers express trust ordering, not a
// probabilistic claim: quoted spans and code refs are unambiguous user
// intent; proper nouns and packages are strong hints; long unknowns are
// kept as last-resort entity-likeness signals.
const CONFIDENCE_QUOTED = 1.0;
const CONFIDENCE_CODE_REF = 0.95;
const CONFIDENCE_PATH = 0.9;
const CONFIDENCE_PACKAGE = 0.9;
const CONFIDENCE_TASK_REF = 0.85;
const CONFIDENCE_PROPER_NOUN = 0.7;
const CONFIDENCE_CJK_PHRASE = 0.6;
const CONFIDENCE_UNKNOWN_LONG = 0.35;

// invariant: every pattern below is `g`-flagged and `u`-flagged. The `u`
// flag is what makes \p{Script=Han} / \p{Script=Hiragana} /
// \p{Script=Katakana} / \p{Script=Hangul} valid.
const QUOTED_RE = /"([^"\n]{1,120})"|'([^'\n]{1,120})'|`([^`\n]{1,120})`/gu;
const CODE_REF_RE = /`([^`\n]{2,80})`/gu;
const PATH_RE = /(?:^|[\s(])((?:\.{1,2}\/|\/)?[\w.-]+(?:\/[\w.-]+)+)/giu;
const PACKAGE_RE = /(@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)/giu;
const TASK_REF_RE = /\b(#[a-z0-9][a-z0-9._-]*|BL-[a-z0-9._-]+|TASK-[a-z0-9._-]+|v\d+\.\d+(?:\.\d+)?(?:[a-z0-9._-]*)?)\b/giu;
// invariant: CAMEL_OR_UPPER_RE keeps {3,} uppercase runs so 2-letter
// acronyms ("AI") fall back to the unknown-long lane while "MCP" /
// "GUI" stay in the proper_noun lane.
const CAMEL_OR_UPPER_RE = /\b([A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+|[A-Z][A-Z0-9_]{2,})\b/gu;
const PROPER_RUN_RE = /\b([A-Z][a-z0-9]+(?:\s+[A-Z][a-z0-9]+)+)\b/gu;
// see also: splitLexicalTokens — same Script-class union for the lexical lane.
const CJK_PHRASE_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]{2,}/gu;

interface RuleHit {
  readonly surface: string;
  readonly kind: EntityCandidate["kind"];
  readonly confidence: number;
  readonly offset: number;
  readonly length: number;
}

/**
 * Pure-rule extractor. Constructed once at recall-service wire time and
 * reused per query. No state mutation, no per-call allocation beyond the
 * candidate list itself.
 */
export class RuleBasedEntityExtractor implements EntityExtractionPort {
  public async extract(
    query: string,
    options?: Readonly<{ readonly maxEntities?: number }>
  ): Promise<readonly Readonly<EntityCandidate>[]> {
    const trimmed = query?.trim() ?? "";
    if (trimmed.length === 0) {
      return Object.freeze([] as readonly EntityCandidate[]);
    }
    const max = clampMaxEntities(options?.maxEntities);
    const hits: RuleHit[] = [];

    collectRegexHits(trimmed, QUOTED_RE, "quoted", CONFIDENCE_QUOTED, hits);
    collectRegexHits(trimmed, CODE_REF_RE, "code_ref", CONFIDENCE_CODE_REF, hits);
    collectRegexHits(trimmed, PATH_RE, "path", CONFIDENCE_PATH, hits);
    collectRegexHits(trimmed, PACKAGE_RE, "package", CONFIDENCE_PACKAGE, hits);
    collectRegexHits(trimmed, TASK_REF_RE, "task_ref", CONFIDENCE_TASK_REF, hits);
    collectRegexHits(trimmed, PROPER_RUN_RE, "proper_noun", CONFIDENCE_PROPER_NOUN, hits);
    collectRegexHits(trimmed, CAMEL_OR_UPPER_RE, "proper_noun", CONFIDENCE_PROPER_NOUN, hits);
    collectRegexHits(trimmed, CJK_PHRASE_RE, "cjk_phrase", CONFIDENCE_CJK_PHRASE, hits);
    collectLongUnknownHits(trimmed, hits);

    const deduped = dedupeByNormalized(hits);
    const sorted = deduped
      .sort((left, right) => {
        const confDelta = right.confidence - left.confidence;
        if (confDelta !== 0) {
          return confDelta;
        }
        // Stable secondary: longer surface wins (a more specific entity
        // beats a shorter substring); finally fall back to offset so the
        // earlier appearance wins on a true tie.
        const lengthDelta = right.surface.length - left.surface.length;
        if (lengthDelta !== 0) {
          return lengthDelta;
        }
        return left.offset - right.offset;
      })
      .slice(0, max);

    return Object.freeze(
      sorted.map((hit) =>
        Object.freeze({
          surface: hit.surface,
          normalized: normalizeSurface(hit.surface),
          kind: hit.kind,
          confidence: hit.confidence,
          source_offset: Object.freeze([hit.offset, hit.offset + hit.length]) as readonly [number, number]
        })
      )
    );
  }
}

function clampMaxEntities(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_MAX_ENTITIES;
  }
  return Math.min(Math.floor(requested), 64);
}

// invariant: all pattern constants in this file are `g`-flagged so
// matchAll iterates every match without lastIndex state leaking across
// queries. see also: QUOTED_RE, CODE_REF_RE, PATH_RE, PACKAGE_RE,
// TASK_REF_RE, CAMEL_OR_UPPER_RE, PROPER_RUN_RE, CJK_PHRASE_RE.
function collectRegexHits(
  text: string,
  pattern: RegExp,
  kind: EntityCandidate["kind"],
  confidence: number,
  out: RuleHit[]
): void {
  for (const match of text.matchAll(pattern)) {
    // anchor: capture-group lanes (quoted / code_ref / path / package)
    // carry the inner span in group 1+; whole-match lanes (proper_noun /
    // task_ref / cjk_phrase) fall back to match[0].
    const captured =
      [...match].slice(1).find((value) => typeof value === "string" && value.trim().length > 0) ?? match[0];
    const surface = captured.trim();
    if (surface.length < MIN_NORMALIZED_LENGTH) {
      continue;
    }
    // anchor: `RegExpMatchArray.index` is typed `number | undefined` by
    // lib.es2020.string.d.ts but is always set on a `g` regex, so the
    // ?? 0 fallback is unreachable at runtime.
    const offset = typeof match.index === "number" ? match.index + match[0].indexOf(captured) : 0;
    out.push({
      surface,
      kind,
      confidence,
      offset,
      length: surface.length
    });
  }
}

function collectLongUnknownHits(text: string, out: RuleHit[]): void {
  // Last-resort entity-likeness signal: long Latin tokens that survived the
  // stop-list (>= LONG_TOKEN_MIN_LENGTH chars). CJK is already covered by
  // CJK_PHRASE_RE; numeric-only and pure-punctuation runs are dropped.
  const tokens = text.split(/[^\p{L}\p{N}_./@#-]+/u);
  let cursor = 0;
  for (const raw of tokens) {
    const offset = text.indexOf(raw, cursor);
    cursor = offset >= 0 ? offset + raw.length : cursor;
    const token = raw.trim();
    if (token.length < LONG_TOKEN_MIN_LENGTH) {
      continue;
    }
    const lower = token.toLocaleLowerCase();
    if (ENTITY_STOP_WORDS.has(lower)) {
      continue;
    }
    if (/^[\p{N}_./@#-]+$/u.test(token)) {
      continue;
    }
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(token)) {
      // CJK runs are handled by the dedicated lane above.
      continue;
    }
    out.push({
      surface: token,
      kind: "unknown",
      confidence: CONFIDENCE_UNKNOWN_LONG,
      offset: offset >= 0 ? offset : 0,
      length: token.length
    });
  }
}

function dedupeByNormalized(hits: readonly RuleHit[]): RuleHit[] {
  // When the same surface (case-insensitive after NFKC) shows up in
  // multiple lanes we keep the highest-confidence kind. Quoted / code_ref
  // therefore dominates over a proper_noun / unknown re-hit on the same
  // span — which matches user-intent: an explicit quotation is the
  // strongest entity signal regardless of lexical shape.
  const best = new Map<string, RuleHit>();
  for (const hit of hits) {
    const key = normalizeSurface(hit.surface);
    if (key.length < MIN_NORMALIZED_LENGTH) {
      continue;
    }
    const prior = best.get(key);
    if (prior === undefined || hit.confidence > prior.confidence) {
      best.set(key, hit);
    }
  }
  return [...best.values()];
}

function normalizeSurface(surface: string): string {
  // NFKC + lower-case is enough for FTS comparison; the existing
  // splitLexicalTokens lowercases the same way, so an entity normalized
  // here matches the lexical index without extra fold steps.
  return surface.normalize("NFKC").toLocaleLowerCase();
}
