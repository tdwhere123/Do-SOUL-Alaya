/**
 * These unquoted cues require a scope interpretation before a source fragment
 * can stand alone. Finding no cue is not proof of general semantic completeness.
 */
export function hasUnquotedSourceDependentScope(source: string, start = 0, end = source.length): boolean {
  const cues = /\b(?:if|unless|whenever|only|provided\s+that|providing\s+that|assuming\s+that|as\s+long\s+as|on\s+condition\s+that)\b/giu;
  for (const match of source.matchAll(cues)) {
    if (match.index >= start && match.index < end && !isInsideSourceQuotation(source, match.index)) return true;
  }
  return false;
}

export function isInsideSourceQuotation(source: string, offset: number): boolean {
  let closing: string | undefined;
  for (let index = 0; index < offset; index += 1) {
    const character = source[index]!;
    // Apostrophes inside words belong to contractions/possessives, not quotations.
    if ((character === "'" || character === "’") &&
        /[\p{L}\p{N}]/u.test(source[index - 1] ?? "") && /[\p{L}\p{N}]/u.test(source[index + 1] ?? "")) continue;
    if (closing !== undefined) {
      if (character === closing) closing = undefined;
    } else if (character === "'" && /[\p{L}\p{N}]/u.test(source[index - 1] ?? "")) {
      // A trailing apostrophe outside a quotation is a possessive, e.g. parents'.
      continue;
    } else if (character === '"' || character === "'") closing = character;
    else if (character === "“") closing = "”";
    else if (character === "‘") closing = "’";
  }
  return closing !== undefined;
}
