import { CJK_INTERROGATIVE_FALLBACK_ATOMS } from "./cjk-interrogative-fallback-atoms.js";

// Han + Hiragana + Katakana are the scripts jieba segments at word level.
// Hangul / Arabic / other scripts fall back to per-codepoint splits inside
// jieba, so routing them through the native owner would fragment words.
const CJK_WORD_SEGMENTER_SCRIPTS =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

export function isCjkSegmentationCandidate(token: string): boolean {
  return CJK_WORD_SEGMENTER_SCRIPTS.test(token);
}

export function fallbackCjkRunPieces(text: string): readonly string[] {
  const pieces: string[] = [];
  let index = 0;
  while (index < text.length) {
    const lexeme = lexemeAt(text, index);
    if (lexeme !== null) {
      pieces.push(lexeme);
      index += lexeme.length;
      continue;
    }
    const next = nextLexemeIndex(text, index);
    pieces.push(text.slice(index, next));
    index = next;
  }
  return pieces.length === 0 ? [text] : pieces;
}

type CjkRunSegmenter = (text: string) => readonly string[];

const UNBOUND_CJK_RUN_FALLBACK_WARNING_CODE = "ALAYA_CJK_RUN_UNBOUND_FALLBACK";
const UNBOUND_CJK_RUN_FALLBACK_WARNING_MESSAGE =
  "[CjkRunPolicy] no native CJK segmenter bound; using interrogative-atom fallback";

let boundCjkRunSegmenter: CjkRunSegmenter | null = null;
let emittedUnboundFallbackWarning = false;

/** First writer wins so source-frame cannot diverge from FTS/memory/recall. */
export function bindCjkRunSegmenter(segmenter: CjkRunSegmenter): void {
  if (boundCjkRunSegmenter !== null) return;
  boundCjkRunSegmenter = segmenter;
}

export function applyBoundCjkRunSegmenter(text: string): readonly string[] {
  if (text.length === 0) {
    return [];
  }
  if (boundCjkRunSegmenter !== null) {
    return boundCjkRunSegmenter(text);
  }
  emitUnboundCjkRunFallbackWarning();
  return fallbackCjkRunPieces(text);
}

function emitUnboundCjkRunFallbackWarning(): void {
  if (emittedUnboundFallbackWarning) return;
  emittedUnboundFallbackWarning = true;
  process.emitWarning(UNBOUND_CJK_RUN_FALLBACK_WARNING_MESSAGE, {
    code: UNBOUND_CJK_RUN_FALLBACK_WARNING_CODE,
    detail: JSON.stringify({ layer: "protocol", state: "unbound" })
  });
}

/** Protocol tests must not leak a bound stub into later cases. */
export function __resetBoundCjkRunSegmenterForTests(): void {
  boundCjkRunSegmenter = null;
  emittedUnboundFallbackWarning = false;
}

function lexemeAt(text: string, index: number): string | null {
  for (const lexeme of CJK_INTERROGATIVE_FALLBACK_ATOMS) {
    if (text.startsWith(lexeme, index)) return lexeme;
  }
  return null;
}

function nextLexemeIndex(text: string, start: number): number {
  let next = text.length;
  for (const lexeme of CJK_INTERROGATIVE_FALLBACK_ATOMS) {
    const found = text.indexOf(lexeme, start);
    if (found >= 0 && found < next) next = found;
  }
  return next;
}
