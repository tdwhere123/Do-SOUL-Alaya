export function containsAlignedTokenSequence(
  fieldTokens: readonly string[],
  demandTokens: readonly string[],
  aligns: (fieldToken: string, demandToken: string) => boolean
): boolean {
  const lastStart = fieldTokens.length - demandTokens.length;
  if (lastStart < 0 || demandTokens.length === 0) return false;
  for (let start = 0; start <= lastStart; start += 1) {
    if (demandTokens.every((demandToken, offset) => {
      const fieldToken = fieldTokens[start + offset];
      return fieldToken !== undefined && aligns(fieldToken, demandToken);
    })) return true;
  }
  return false;
}
