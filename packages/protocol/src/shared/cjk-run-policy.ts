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

let boundCjkRunSegmenter: CjkRunSegmenter | null = null;

/** Native CJK owner registers here so source-frame can use jieba without a protocol native dep. */
export function bindCjkRunSegmenter(segmenter: CjkRunSegmenter): void {
  boundCjkRunSegmenter = segmenter;
}

export function applyBoundCjkRunSegmenter(text: string): readonly string[] {
  if (text.length === 0) {
    return [];
  }
  if (boundCjkRunSegmenter !== null) {
    return boundCjkRunSegmenter(text);
  }
  return fallbackCjkRunPieces(text);
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
