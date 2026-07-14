// Family decorrelation is default-on. This flag no longer changes fusion; the
// export stays so env maps that still list ALAYA_RECALL_LEXICAL_DECORR remain stable.
export function lexicalDecorrEnabled(): boolean {
  return false;
}
