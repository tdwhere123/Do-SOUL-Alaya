export const CLAUSE_BOUNDARIES: ReadonlySet<string> = new Set([
  "after", "before", "because", "if", "since", "that", "when", "where",
  "while", "who", "which", "until", "than"
]);

export const WH_WORDS: ReadonlySet<string> = new Set([
  "what", "which", "who", "whom", "where", "when", "why", "how"
]);

export const BE_AUXILIARIES: ReadonlySet<string> = new Set([
  "am", "is", "are", "was", "were", "be", "been", "being"
]);

export const AUXILIARIES: ReadonlySet<string> = new Set([
  ...BE_AUXILIARIES,
  "do", "does", "did", "has", "have", "had", "can", "could", "will",
  "would", "shall", "should", "may", "might", "must"
]);
