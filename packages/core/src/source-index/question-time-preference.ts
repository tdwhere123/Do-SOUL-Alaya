import type { QuestionTimePreference, SourceIndexAcquisitionResult, SourceIndexLexicalCandidate,
  SourceIndexNominationAccounting, SourceIndexQueryRepository, SourceIndexQueryResources, SourceIndexTarget,
  SourceSemanticNominationOccurrence, SourceSemanticResourceLedger } from "@do-soul/alaya-protocol";

type MutableAccounting = { -readonly [K in keyof SourceIndexNominationAccounting]: SourceIndexNominationAccounting[K] };

/** Replace the bounded prefix only after preparation succeeds. Original admitted
 * roots remain fallback candidates, not an unbounded second acquisition route.
 * The caller owns admission, debit capture and the single attempt/root ledger. */
export function preferQuestionTime<N extends { source: SourceIndexTarget }>(input: Readonly<{
  repository: SourceIndexQueryRepository; workspace: string; navigation: string;
  preference: QuestionTimePreference; nominations: Map<string, N>; counts: MutableAccounting;
  maxRoots: number; maxAttempts: number; meter: SourceSemanticResourceLedger;
  absorb: (resources: SourceIndexQueryResources) => void;
  nominate: (candidates: readonly SourceIndexLexicalCandidate[]) => void;
  refusals: SourceIndexAcquisitionResult["resource_refusals"][number][];
  occurrences?: SourceSemanticNominationOccurrence[];
  ordered: (rootKeys: readonly string[]) => void;
}>): boolean {
  const { meter, absorb, nominations, counts } = input;
  const original = [...nominations.entries()];
  meter.charge(original.length * 3, original.length * 24, "question time ordering and fallback");
  const domain = input.repository.readQuestionTimeDomain!(input.workspace, input.preference,
    original.map(([key]) => key), meter.remaining());
  absorb(domain.resources);
  if (domain.status !== "ready") {
    input.refusals.push({ stage: "nomination", phase: domain.reason });
    return true;
  }
  const matching = new Set(domain.matched_root_keys);
  const remaining = input.maxAttempts - counts.attempted;
  const lexical = remaining === 0 ? undefined : input.repository.readLexicalCandidates(
    input.workspace, input.navigation, remaining, meter.remaining(), input.preference);
  if (lexical !== undefined) {
    absorb(lexical.resources);
    if (lexical.resource_refusal !== null) input.refusals.push(lexical.resource_refusal);
  }
  nominations.clear();
  for (const [key, row] of original) if (matching.has(key)) nominations.set(key, row);
  try {
    input.nominate(lexical?.candidates ?? []);
  } finally {
    for (const [key, row] of original) {
      if (nominations.size >= input.maxRoots) break;
      if (!nominations.has(key)) nominations.set(key, row);
    }
    // Counts describe final retained outcomes; paid attempts are never refunded.
    const displaced = original.filter(([key]) => !nominations.has(key)).length;
    counts.admitted -= displaced;
    counts.rejected += displaced;
    counts.nomination_limit += displaced;
    input.ordered([...nominations.keys()]);
    if (input.occurrences !== undefined) input.occurrences.splice(0, input.occurrences.length,
      ...input.occurrences.filter(row => nominations.has(row.source.root_key)));
  }
  return lexical !== undefined && lexical.completion !== "complete";
}
