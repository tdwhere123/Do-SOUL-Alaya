import { isCjkSegmentationCandidate, segmentCjkRun } from
  "../cjk-segmentation.js";

export { factFrameWordPiecesCoverRun } from "./word-piece-coverage.js";

export type FactFrameSourceToken = Readonly<{
  readonly text: string;
  readonly normalized: string;
  readonly start: number;
  readonly end: number;
}>;

export function tokenizeFactFrameWordPieces(source: string): readonly string[] {
  return Object.freeze(tokenizeFactFrameSource(source).map((token) => token.normalized));
}

export function tokenizeFactFrameSource(
  source: string
): readonly FactFrameSourceToken[] {
  const tokens: FactFrameSourceToken[] = [];
  for (const match of source.matchAll(FACT_FRAME_SOURCE_TOKEN_PATTERN)) {
    const start = match.index;
    const text = match[0];
    if (isCjkSegmentationCandidate(text)) {
      tokens.push(...expandCjkFactFrameToken(text, start));
      continue;
    }
    tokens.push(factFrameToken(text, start));
  }
  return Object.freeze(tokens);
}

function expandCjkFactFrameToken(
  raw: string,
  start: number
): readonly FactFrameSourceToken[] {
  const pieces = segmentCjkRun(raw);
  const tokens: FactFrameSourceToken[] = [];
  let offset = 0;
  for (const piece of pieces) {
    const index = raw.indexOf(piece, offset);
    if (index < 0) continue;
    tokens.push(factFrameToken(piece, start + index));
    offset = index + piece.length;
  }
  return tokens.length > 0 ? tokens : [factFrameToken(raw, start)];
}

function factFrameToken(text: string, start: number): FactFrameSourceToken {
  return Object.freeze({
    text,
    normalized: text.normalize("NFKC").toLowerCase(),
    start,
    end: start + text.length
  });
}

export function sliceFactFrameTokens(
  source: string,
  tokens: readonly FactFrameSourceToken[],
  start: number,
  end: number
): string {
  return source.slice(tokens[start]!.start, tokens[end - 1]!.end);
}

const FACT_FRAME_SOURCE_TOKEN_PATTERN =
  /[\p{L}\p{N}@#](?:[\p{L}\p{N}_./@#-]*[\p{L}\p{N}@#])?(?:['\u2019][\p{L}\p{N}]+)?/gu;
