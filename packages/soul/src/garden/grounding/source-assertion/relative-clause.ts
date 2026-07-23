const RELATIVE_CLAUSE_OPEN =
  /^(?:\s*[,;:]\s*|\s*[—–‒-]\s*|\s*\(\s*|\s+)(?:which|who)\b/iu;

const ASSERTION_PRESERVING_SURPRISE_SUFFIX =
  /^\s*,\s*which\s+(?:was|is)\s+(?:a\s+)?(?:nice|pleasant|welcome|great)\s+surprise(?:\s+to\s+(?:me|us|them)|\s+since\s+I\s+(?:had\s+forgotten\s+it|didn't\s+know\s+I\s+had\s+it\s+in\s+my\s+email\s+inbox))?\.\s*(?:\r?\n(?:Assistant|助手)\s*:[\s\S]*)?$/iu;

const ASSERTION_PRESERVING_FORGOTTEN_SUFFIX =
  /^\s*,\s*which surprised me because I had forgotten it\.\s*(?:\r?\n(?:Assistant|助手)\s*:[\s\S]*)?$/iu;

export function hasRelativeClauseSuffix(suffix: string): boolean {
  return RELATIVE_CLAUSE_OPEN.test(suffix);
}

/**
 * Releasing a prefix from a relative clause drops context that can overturn it.
 * Keep only a closed, additive surprise grammar. A prefix-only match would
 * accept a later retraction, so catalog enumeration must require the whole
 * suffix that the resolver is willing to treat as evidence-preserving.
 */
export function hasAssertionPreservingRelativeClauseSuffix(suffix: string): boolean {
  return ASSERTION_PRESERVING_SURPRISE_SUFFIX.test(suffix) ||
    ASSERTION_PRESERVING_FORGOTTEN_SUFFIX.test(suffix);
}
