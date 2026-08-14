import { normalizeMemoryObjectKeySurface, type MemoryObjectKey } from "@do-soul/alaya-protocol";
import { formedKey } from "./form-key.js";
import { occupies } from "./occupancy.js";
import { tokenizeWithSpans, type TokenSpan } from "../normalize/tokenize.js";
import type { DraftMemoryObjectKey, MintableEvidence } from "../types.js";

const DISCOURSE_STOP = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "her", "his",
  "i", "in", "is", "it", "its", "me", "my", "of", "on", "or", "our", "she", "he",
  "that", "the", "their", "them", "they", "this", "to", "was", "we", "were",
  "with", "you", "your", "way", "also", "just"
]);

export function mintGistRemainderKeys(input: Readonly<{
  readonly workspace_id: string;
  readonly owner_id: string;
  readonly memory_content: string;
  readonly evidence: Readonly<MintableEvidence>;
  readonly occupied: ReadonlySet<string>;
}>): readonly Readonly<MemoryObjectKey>[] {
  const contentNormalized = normalizeMemoryObjectKeySurface(input.memory_content);
  const contentTokens = new Set(
    tokenizeWithSpans(input.memory_content).map((span) =>
      normalizeMemoryObjectKeySurface(span.token)
    )
  );
  const phrases = remainderPhrases(tokenizeWithSpans(input.evidence.gist), contentTokens);
  return Object.freeze(phrases.flatMap((phrase) => {
    if (occupies(phrase.surface, input.occupied, contentNormalized)) return [];
    return formedKey(gistDraft(input, phrase));
  }));
}

function remainderPhrases(
  spans: readonly TokenSpan[],
  contentTokens: ReadonlySet<string>
): readonly Readonly<{ readonly surface: string; readonly start: number; readonly end: number }>[] {
  const phrases: Array<{ surface: string; start: number; end: number }> = [];
  let current: TokenSpan[] = [];
  for (const span of spans) {
    const normalized = normalizeMemoryObjectKeySurface(span.token);
    if (
      contentTokens.has(normalized) ||
      DISCOURSE_STOP.has(normalized) ||
      isNonLexicalToken(span.token)
    ) {
      pushPhrase(phrases, current);
      current = [];
      continue;
    }
    current.push(span);
  }
  pushPhrase(phrases, current);
  return Object.freeze(phrases);
}

function pushPhrase(
  phrases: Array<{ surface: string; start: number; end: number }>,
  current: readonly TokenSpan[]
): void {
  if (current.length === 0) return;
  const first = current[0];
  const last = current[current.length - 1];
  if (first === undefined || last === undefined) return;
  const surface = current.map((span) => span.token).join(joinSeparator(current));
  if (!isDiscriminatingPhrase(current, surface)) return;
  phrases.push({ surface, start: first.start, end: last.end });
}

function joinSeparator(current: readonly TokenSpan[]): string {
  return current.some((span) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(span.token))
    ? ""
    : " ";
}

function isDiscriminatingPhrase(spans: readonly TokenSpan[], surface: string): boolean {
  if (!spans.some((span) => !isNonLexicalToken(span.token))) return false;
  if (spans.length >= 2) return surface.trim().length > 0;
  const token = spans[0]?.token ?? "";
  return token.length >= 4 || /[\p{Script=Han}]/u.test(token);
}

function isNonLexicalToken(token: string): boolean {
  // Digit/punctuation groups are timestamp fragments, not addressable lexical surfaces.
  return !/[\p{L}]/u.test(token);
}

function gistDraft(
  input: Readonly<{
    readonly workspace_id: string;
    readonly owner_id: string;
    readonly evidence: Readonly<MintableEvidence>;
  }>,
  phrase: Readonly<{ readonly surface: string; readonly start: number; readonly end: number }>
): DraftMemoryObjectKey {
  return {
    workspace_id: input.workspace_id,
    owner_id: input.owner_id,
    key_type: "gist_remainder",
    surface: phrase.surface,
    language: /[\p{Script=Han}]/u.test(phrase.surface) ? "zh" : "en",
    source_kind: "evidence_gist",
    source_ref: `evidence:${input.evidence.object_id}:gist:${phrase.start}:${phrase.end}`
  };
}
