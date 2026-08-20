import { isCjkSegmentationCandidate } from "../cjk-segmentation.js";

const CJK_NEGATION_PREFIXES = ["不", "非", "没", "无"] as const;

export function factFrameWordPiecesCoverRun(
  queryPieces: readonly string[],
  evidencePieces: readonly string[]
): boolean {
  if (queryPieces.length === 0 || evidencePieces.length === 0) return false;
  return hasContiguousPieceWindow(queryPieces, evidencePieces) ||
    hasCjkCanonicalRunSpan(queryPieces, evidencePieces);
}

function hasContiguousPieceWindow(
  queryPieces: readonly string[],
  evidencePieces: readonly string[]
): boolean {
  const lastStart = evidencePieces.length - queryPieces.length;
  for (let start = 0; start <= lastStart; start += 1) {
    if (!queryPieces.every((piece, offset) => piece === evidencePieces[start + offset])) {
      continue;
    }
    if (hasNegationBeforePiece(evidencePieces, start)) continue;
    return true;
  }
  return false;
}

function hasCjkCanonicalRunSpan(
  queryPieces: readonly string[],
  evidencePieces: readonly string[]
): boolean {
  if (!queryPieces.every(isCjkSegmentationCandidate) ||
      !evidencePieces.every(isCjkSegmentationCandidate)) {
    return false;
  }
  const queryRun = queryPieces.join("");
  const evidenceRun = evidencePieces.join("");
  let from = 0;
  while (from + queryRun.length <= evidenceRun.length) {
    const start = evidenceRun.indexOf(queryRun, from);
    if (start < 0) return false;
    if (!hasNegationBeforeRun(evidenceRun, start)) return true;
    from = start + 1;
  }
  return false;
}

function hasNegationBeforePiece(
  evidencePieces: readonly string[],
  start: number
): boolean {
  if (start === 0) return false;
  const previous = evidencePieces[start - 1] ?? "";
  return isCjkNegationPiece(previous);
}

function hasNegationBeforeRun(evidenceRun: string, start: number): boolean {
  if (start === 0) return false;
  const prefix = evidenceRun[start - 1] ?? "";
  return (CJK_NEGATION_PREFIXES as readonly string[]).includes(prefix);
}

function isCjkNegationPiece(piece: string): boolean {
  return (CJK_NEGATION_PREFIXES as readonly string[]).some((prefix) =>
    piece === prefix || piece.endsWith(prefix));
}
