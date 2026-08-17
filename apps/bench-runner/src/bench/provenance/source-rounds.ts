export interface LongMemEvalSourceRound {
  readonly sessionIndex: number;
  readonly roundIndex: number;
  readonly sessionId: string;
  readonly hasAnswer: boolean;
}

export interface LongMemEvalSourceAttribution {
  readonly sessionId: string;
  readonly hasAnswer: boolean;
  readonly sourceRounds?: readonly LongMemEvalSourceRound[];
}

export function isLongMemEvalGoldSource(
  attribution: LongMemEvalSourceAttribution,
  answerSessionIds: ReadonlySet<string>
): boolean {
  return longMemEvalAttributionSources(attribution).some((source) =>
    source.hasAnswer && answerSessionIds.has(source.sessionId));
}

export function longMemEvalAttributionSources(
  attribution: LongMemEvalSourceAttribution
): readonly Pick<LongMemEvalSourceRound, "sessionId" | "hasAnswer">[] {
  const sources = attribution.sourceRounds;
  return sources === undefined || sources.length === 0 ? [attribution] : sources;
}

export function mergeLongMemEvalSourceRounds(
  prior: readonly LongMemEvalSourceRound[],
  incoming: readonly LongMemEvalSourceRound[]
): readonly LongMemEvalSourceRound[] {
  const merged = [...prior];
  const byKey = new Map(prior.map((source) => [longMemEvalSourceRoundKey(source), source]));
  for (const source of incoming) {
    const key = longMemEvalSourceRoundKey(source);
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, source);
      merged.push(source);
    } else if (!sameLongMemEvalSourceRound(existing, source)) {
      throw new Error(`conflicting LongMemEval source round ${key}`);
    }
  }
  return merged;
}

export function hasOrderedUniqueLongMemEvalSourceRounds(
  sources: readonly LongMemEvalSourceRound[]
): boolean {
  const seen = new Set<string>();
  let prior: LongMemEvalSourceRound | undefined;
  for (const source of sources) {
    const key = longMemEvalSourceRoundKey(source);
    if (seen.has(key) || (prior !== undefined && compareSourceRounds(prior, source) >= 0)) {
      return false;
    }
    seen.add(key);
    prior = source;
  }
  return sources.length > 0;
}

export function longMemEvalSourceRoundKey(
  source: Pick<LongMemEvalSourceRound, "sessionIndex" | "roundIndex">
): string {
  return `${source.sessionIndex}:${source.roundIndex}`;
}

function sameLongMemEvalSourceRound(
  left: LongMemEvalSourceRound,
  right: LongMemEvalSourceRound
): boolean {
  return left.sessionIndex === right.sessionIndex && left.roundIndex === right.roundIndex &&
    left.sessionId === right.sessionId && left.hasAnswer === right.hasAnswer;
}

function compareSourceRounds(left: LongMemEvalSourceRound, right: LongMemEvalSourceRound): number {
  return left.sessionIndex - right.sessionIndex || left.roundIndex - right.roundIndex;
}
