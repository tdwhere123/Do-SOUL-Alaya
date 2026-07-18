export interface ExtractionAuthorityKeySpaceEvidence {
  readonly windowTurnOccurrences?: number;
  readonly windowUniqueCacheKeys?: number;
  readonly authorizedQuestionCount?: number;
  readonly authorizedTurnOccurrences?: number;
  readonly authorizedUniqueCacheKeys?: number;
}

export function isExtractionAuthorityKeySpaceEvidence(
  value: ExtractionAuthorityKeySpaceEvidence,
  windowQuestionCount: number,
  inventoryExpectedKeys: number
): boolean {
  const fields = [
    value.windowTurnOccurrences,
    value.windowUniqueCacheKeys,
    value.authorizedQuestionCount,
    value.authorizedTurnOccurrences,
    value.authorizedUniqueCacheKeys
  ];
  if (fields.every((field) => field === undefined)) return true;
  if (!fields.every(isNonNegativeSafeInteger)) return false;

  const windowOccurrences = value.windowTurnOccurrences!;
  const windowKeys = value.windowUniqueCacheKeys!;
  const authorizedQuestions = value.authorizedQuestionCount!;
  const authorizedOccurrences = value.authorizedTurnOccurrences!;
  const authorizedKeys = value.authorizedUniqueCacheKeys!;
  return authorizedQuestions <= windowQuestionCount &&
    authorizedOccurrences <= windowOccurrences &&
    authorizedKeys <= windowKeys &&
    windowOccurrences >= windowKeys &&
    authorizedOccurrences >= authorizedKeys &&
    authorizedKeys === inventoryExpectedKeys &&
    (authorizedQuestions !== windowQuestionCount ||
      (authorizedOccurrences === windowOccurrences && authorizedKeys === windowKeys));
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
