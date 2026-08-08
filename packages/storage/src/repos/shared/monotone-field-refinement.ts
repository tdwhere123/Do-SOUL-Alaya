interface FieldMatchIdentity {
  readonly object_id: string;
  readonly matched_projection?: Readonly<{
    readonly projection_id: number;
    readonly projection_kind: string;
  }>;
}

interface FieldLaneObservation extends FieldMatchIdentity {
  readonly rank: number;
  readonly source_id?: string;
}

interface FieldView<Match, Lanes extends readonly unknown[]> {
  readonly matches: readonly Readonly<Match>[];
  readonly lanes: Lanes;
}

export function buildMonotoneFieldRefinementLevels<
  Match extends FieldMatchIdentity,
  Lanes extends readonly unknown[]
>(
  baseMatches: readonly Readonly<Match>[],
  depths: readonly number[],
  buildView: (depth: number) => Readonly<FieldView<Match, Lanes>>
): readonly Readonly<FieldView<Match, Lanes> & { readonly requested_depth: number }>[] {
  let previousMatches = baseMatches;
  return Object.freeze(depths.map((depth) => {
    const view = buildView(depth);
    const matches = preserveMatchPrefix(previousMatches, view.matches, depth);
    previousMatches = matches;
    return Object.freeze({ requested_depth: depth, matches, lanes: view.lanes });
  }));
}

function preserveMatchPrefix<Match extends FieldMatchIdentity>(
  previous: readonly Readonly<Match>[],
  next: readonly Readonly<Match>[],
  limit: number
): readonly Readonly<Match>[] {
  const nextByIdentity = new Map(next.map((match) => [matchIdentity(match), match]));
  const observedOwners = new Set(previous.map((match) => match.object_id));
  const matches = previous.map((match) => nextByIdentity.get(matchIdentity(match)) ?? match);
  for (const match of next) {
    if (matches.length >= limit) break;
    if (observedOwners.has(match.object_id)) continue;
    observedOwners.add(match.object_id);
    matches.push(match);
  }
  return Object.freeze(matches);
}

export function preserveFieldLaneObservationPrefix<
  Observation extends FieldLaneObservation
>(
  previous: readonly Readonly<Observation>[],
  next: readonly Readonly<Observation>[]
): readonly Readonly<Observation>[] {
  const nextByIdentity = new Map(next.map((observation) =>
    [observationIdentity(observation), observation]
  ));
  const observedOwners = new Set(previous.map((observation) => observation.object_id));
  const observations = previous.map((observation) => {
    const refined = nextByIdentity.get(observationIdentity(observation));
    return refined === undefined
      ? observation
      : Object.freeze({ ...refined, rank: observation.rank });
  });
  for (const observation of next) {
    if (observations.length >= next.length) break;
    if (observedOwners.has(observation.object_id)) continue;
    observedOwners.add(observation.object_id);
    observations.push(Object.freeze({ ...observation, rank: observations.length + 1 }));
  }
  return Object.freeze(observations);
}

function matchIdentity(match: Readonly<FieldMatchIdentity>): string {
  return JSON.stringify([
    match.object_id,
    match.matched_projection?.projection_kind ?? null,
    match.matched_projection?.projection_id ?? null
  ]);
}

function observationIdentity(observation: Readonly<FieldLaneObservation>): string {
  return JSON.stringify([
    matchIdentity(observation),
    observation.source_id ?? null
  ]);
}
