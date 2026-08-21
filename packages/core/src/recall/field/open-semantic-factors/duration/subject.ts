import type { OpenSemanticFactor } from "@do-soul/alaya-protocol";
import { isRuleBasedGenericSpeaker } from
  "../../../../shared/query-fact-frame-extraction-rules.js";
import {
  factFrameWordPiecesCoverRun,
  tokenizeFactFrameWordPieces
} from "../../../../shared/fact-frame-grammar/source-text.js";
import { isAdmittedLexicalTerm, splitLexicalTokens } from
  "../../../../recall/query/recall-query-probes.js";

export function sourceBoundSubjectCoversQuery(
  queryFactor: Readonly<OpenSemanticFactor>,
  evidenceFactor: Readonly<OpenSemanticFactor>
): boolean {
  if (isGenericSpeakerFactor(queryFactor) || isGenericSpeakerFactor(evidenceFactor)) {
    return false;
  }
  const queryTokens = subjectWordPieces(queryFactor);
  if (queryTokens.length === 0) return false;
  const evidenceTokens = subjectWordPieces(evidenceFactor);
  return factFrameWordPiecesCoverRun(queryTokens, evidenceTokens);
}

function subjectWordPieces(factor: Readonly<OpenSemanticFactor>): readonly string[] {
  return uniqueTokens([
    ...wordPiecesFromText(factor.surface),
    ...wordPiecesFromText(factor.semantic_identity)
  ]);
}

export function leftoverGenericSpeakerContentTokens(text: string): readonly string[] {
  return splitLexicalTokens(text).filter(isNonGenericSpeakerToken);
}

function wordPiecesFromText(text: string): readonly string[] {
  return tokenizeFactFrameWordPieces(text).filter(isNonGenericSpeakerToken);
}

function isNonGenericSpeakerToken(token: string): boolean {
  return isAdmittedLexicalTerm(token) && !isRuleBasedGenericSpeaker(token);
}

function isGenericSpeakerFactor(factor: Readonly<OpenSemanticFactor>): boolean {
  return subjectWordPieces(factor).length === 0;
}

function uniqueTokens(tokens: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(tokens)]);
}
