const RELATIVE_CLAUSE_OPEN =
  /^(?:\s*[,;:]\s*|\s*[—–‒-]\s*|\s*\(\s*|\s+)(?:which|who)\b/iu;

export function hasRelativeClauseSuffix(suffix: string): boolean {
  return RELATIVE_CLAUSE_OPEN.test(suffix);
}

/**
 * Releasing a prefix from a relative clause drops context that can overturn it.
 * Keep only the existing additive surprise grammar, whose suffix cannot change
 * the asserted event, so catalog enumeration follows resolver policy.
 */
export function hasAssertionPreservingRelativeClauseSuffix(suffix: string): boolean {
  return /^\s*,\s*which\s+(?:was|is)\s+(?:a\s+)?(?:nice|pleasant|welcome|great)\s+surprise\b/iu.test(
    suffix
  ) || /^\s*,\s*which surprised me because I had forgotten it\.\s*(?:\r?\n(?:Assistant|助手)\s*:[\s\S]*)?$/iu.test(
    suffix
  );
}
