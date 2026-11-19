import {
  SourceSemanticResourceExhausted, SourceSemanticResourceLedger, sourceIndexNativeRootKey,
  type QuestionTimePreference, type SourceIndexAcquisitionResult, type SourceIndexLexicalCandidate,
  type SourceIndexNominationAccounting, type SourceIndexQueryAdmission, type SourceIndexQueryRepository,
  type SourceIndexQueryResources, type SourceIndexScopeAdmission, type SourceIndexTarget,
  type SourceIndexVectorBinding, type SourceSemanticNominationOccurrence, type QualifiedTaskObservation
} from "@do-soul/alaya-protocol";

/** The window dates the asked event. A past event is recorded at or after its start and never after the
 * question clock, so the recorded-time domain is [earliest start, clock date]; a window wholly after the
 * clock leaves no domain and no preference. */
export function recordedQuestionTime(preference: QuestionTimePreference): QuestionTimePreference | undefined {
  const clock = preference.interpretation_clock.slice(0, 10);
  const starts = preference.intervals.map(interval => interval.start).filter(start => start <= clock).sort();
  return starts.length === 0 ? undefined
    : { interpretation_clock: preference.interpretation_clock, intervals: [{ start: starts[0]!, end: clock }] };
}

/** Fund the incumbent before optional preference inspection; a changed capture is separately charged. */
export type SourcePreferenceRetention = Readonly<{
  retain: (capture: Readonly<{ result: SourceIndexAcquisitionResult; witness: readonly SourceSemanticNominationOccurrence[];
    question_time_order: readonly string[]; task_observations?: readonly QualifiedTaskObservation[] }>,
    meter: SourceSemanticResourceLedger) => number;
  source_id?: string;
  readInterpretation?: import("./task-observation-binding.js").TaskInterpretationReader;
}>;

type MutableAccounting = { -readonly [K in keyof SourceIndexNominationAccounting]: SourceIndexNominationAccounting[K] };

/** Replace the bounded prefix only after preparation succeeds. Original admitted
 * roots remain fallback candidates, not an unbounded second acquisition route.
 * The caller owns admission, debit capture and the single attempt/root ledger. */
export function preferQuestionTime<N extends { source: SourceIndexTarget }>(input: Readonly<{
  repository: SourceIndexQueryRepository; workspace: string; navigation: string;
  preference: QuestionTimePreference; nominations: Map<string, N>; counts: MutableAccounting;
  maxRoots: number; maxAttempts: number; meter: SourceSemanticResourceLedger;
  absorb: (resources: SourceIndexQueryResources) => void;
  nominate: (candidates: readonly SourceIndexLexicalCandidate[], protectedHeadKeys: readonly string[]) => void;
  refusals: SourceIndexAcquisitionResult["resource_refusals"][number][];
  occurrences?: SourceSemanticNominationOccurrence[];
  ordered: (rootKeys: readonly string[]) => void;
  observeInventory?: (original: readonly (readonly [string, N])[], restrictedComplete: boolean, reason?: string) => void;
  beforeFinalRetention?: (original: readonly (readonly [string, N])[]) => void;
}>): boolean {
  const { meter, absorb, nominations, counts } = input;
  const original = [...nominations.entries()];
  // Matching and this head are both subsets of original, so their union always fits maxRoots.
  const protectedHeadKeys = original.slice(0, Math.min(5, Math.floor(input.maxRoots / 3))).map(([key]) => key);
  meter.charge(original.length * 3, original.length * 24, "question time ordering and fallback");
  const domain = input.repository.readQuestionTimeDomain!(input.workspace, input.preference,
    original.map(([key]) => key), meter.remaining());
  absorb(domain.resources);
  if (domain.status !== "ready") {
    input.refusals.push({ stage: "nomination", phase: domain.reason });
    input.observeInventory?.(original, false, domain.reason);
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
  let completed = false;
  try {
    input.nominate(lexical?.candidates ?? [], protectedHeadKeys);
    completed = true;
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
    input.observeInventory?.(original, completed && (lexical === undefined || lexical.completion === "complete"));
    input.beforeFinalRetention?.(original);
    input.ordered([...nominations.keys()]);
    if (input.occurrences !== undefined) input.occurrences.splice(0, input.occurrences.length,
      ...input.occurrences.filter(row => nominations.has(sourceIndexNativeRootKey(row.source))));
  }
  return lexical !== undefined && lexical.completion !== "complete";
}

export type QuestionTimeIndexMemberPrefix = Readonly<{
  unrestrictedLexical: readonly { source: SourceIndexTarget }[];
  unrestrictedVector: readonly { source: SourceIndexTarget }[];
  cursor: Readonly<{ lexicalIndex: number; vectorIndex: number; takeLexical: boolean }>;
  originalPrefix: readonly (readonly [string, SourceIndexTarget])[];
}>;

/** Use the saved native order and the final ranked set. Tail reads share the pinned snapshot
 * but only spend the listing allowance. */
export function collectQuestionTimeIndexMembers(input: QuestionTimeIndexMemberPrefix & Readonly<{
  targetCount: number;
  maxExtraAttempts: number;
  nominationKeys: Iterable<string>;
  indexMemberKeys: ReadonlySet<string>;
  indexMembers: readonly SourceIndexTarget[];
  retainIndexMember: (key: string, source: SourceIndexTarget) => void;
  repository: SourceIndexQueryRepository;
  vectorBinding: SourceIndexVectorBinding | null;
  unboundAdmissions: ReadonlyMap<string, SourceIndexQueryAdmission>;
  boundAdmissions: ReadonlyMap<string, SourceIndexQueryAdmission>;
  admitScope: SourceIndexScopeAdmission;
}>): void {
  const { unrestrictedLexical, unrestrictedVector, indexMembers, targetCount, retainIndexMember } = input;
  const seen = new Set([...input.nominationKeys, ...input.indexMemberKeys]);
  for (const [key, source] of input.originalPrefix) {
    if (indexMembers.length >= targetCount) return;
    if (seen.has(key)) continue;
    seen.add(key);
    retainIndexMember(key, source);
  }
  if (indexMembers.length >= targetCount || input.maxExtraAttempts === 0) return;
  const listingMeter = new SourceSemanticResourceLedger({ work_units: 524_288, memory_bytes: 8 * 1024 * 1024 });
  let { lexicalIndex, vectorIndex, takeLexical } = input.cursor;
  try {
    for (let extraAttempts = 0; extraAttempts < input.maxExtraAttempts && indexMembers.length < targetCount
      && (lexicalIndex < unrestrictedLexical.length || vectorIndex < unrestrictedVector.length); extraAttempts++) {
      const lexicalTurn: boolean = lexicalIndex < unrestrictedLexical.length && (takeLexical || vectorIndex >= unrestrictedVector.length);
      takeLexical = !lexicalTurn;
      const { source } = lexicalTurn ? unrestrictedLexical[lexicalIndex++]! : unrestrictedVector[vectorIndex++]!;
      listingMeter.charge(1, 0, "index member tail attempt");
      const key = sourceIndexNativeRootKey(source);
      if (seen.has(key)) continue;
      const admissions = lexicalTurn ? input.unboundAdmissions : input.boundAdmissions;
      let admission = admissions.get(source.root_key);
      if (admission !== undefined) {
        listingMeter.charge(1, 0, "index member admission reuse");
      } else {
        admission = input.repository.admitQueryCandidate(source, lexicalTurn ? null : input.vectorBinding, listingMeter.remaining());
        listingMeter.charge(admission.resources.work, admission.resources.memory_bytes, "index member candidate admission");
      }
      if (admission.status === "resource_limited") break;
      if (admission.status !== "ready") continue;
      listingMeter.charge(1 + (admission.scope_class?.length ?? 0), 0, "index member scope admission");
      if (input.admitScope(admission.scope_class, source) !== "admitted") continue;
      seen.add(key);
      retainIndexMember(key, source);
    }
  } catch (error) {
    if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
  }
}
