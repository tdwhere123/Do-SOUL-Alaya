import { isCjkSegmentationCandidate, segmentCjkRun } from "../../shared/cjk-segmentation.js";

export interface TokenSpan {
  readonly token: string;
  readonly start: number;
  readonly end: number;
}

const TOKEN_PATTERN = /[\p{L}\p{N}_]+/gu;

export function tokenizeWithSpans(text: string): readonly TokenSpan[] {
  const spans: TokenSpan[] = [];
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const start = match.index ?? 0;
    const raw = match[0];
    if (raw === undefined) continue;
    if (isCjkSegmentationCandidate(raw)) {
      spans.push(...segmentCjkToken(raw, start));
    } else {
      spans.push({ token: raw, start, end: start + raw.length });
    }
  }
  return Object.freeze(spans);
}

function segmentCjkToken(raw: string, start: number): readonly TokenSpan[] {
  const pieces = segmentCjkRun(raw);
  const spans: TokenSpan[] = [];
  let offset = 0;
  for (const piece of pieces) {
    const index = raw.indexOf(piece, offset);
    if (index < 0) continue;
    spans.push({
      token: piece,
      start: start + index,
      end: start + index + piece.length
    });
    offset = index + piece.length;
  }
  return spans.length > 0 ? spans : [{ token: raw, start, end: start + raw.length }];
}
