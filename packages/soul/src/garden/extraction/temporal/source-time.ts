import { resolveTemporalProjection, timeConcernPattern, type TemporalProjection } from "../time-concern-projection.js";

const ROLE_CLAUSE_SEPARATOR =
  /(?:[;,.!?\n；，。！？]+|\b(?:and|but|while|whereas|then)\b|(?:并且|而|但|然后|同时))/giu;

export interface SourceTemporalCandidate {
  readonly start: number;
  readonly end: number;
  readonly projection: TemporalProjection;
  readonly role: "event" | "validity" | "unknown";
  readonly bounded: boolean;
}

type TemporalMatch = Pick<SourceTemporalCandidate, "start" | "end" | "projection">;
type TemporalSpan = Pick<SourceTemporalCandidate, "start" | "end">;

/** Source inventory, range binding and role interpretation share one owner. */
export function resolveSourceTemporalCandidates(
  source: string,
  anchor: string | undefined
): readonly SourceTemporalCandidate[] {
  const matches: TemporalMatch[] = [];
  const unresolved: TemporalSpan[] = [];
  for (const match of source.matchAll(timeConcernPattern())) {
    const projection = resolveTemporalProjection(match[0], anchor ?? null);
    // An unresolved date is part of the inventory too. Omitting it could turn
    // a partial alternative/range into an apparently unique absolute date.
    if (projection === null) {
      unresolved.push({ start: match.index, end: match.index + match[0].length });
      continue;
    }
    if (projection.time_source === "explicit" &&
        (/[a-z\d]$/iu.test(source.slice(0, match.index)) ||
          /^(?:[-/]\d|[a-z\d])/iu.test(source.slice(match.index + match[0].length)))) continue;
    // Year discovery includes its preposition; role/range binding needs the
    // actual date span, just as month/day discovery does.
    const yearOffset = projection.time_precision === "year" && projection.time_source === "explicit"
      ? match[0].search(/[1-9]\d{3}/u) : 0;
    matches.push({ start: match.index + Math.max(0, yearOffset), end: match.index + match[0].length, projection });
  }
  const range = sourceRangeMatch(source, matches);
  const candidates = (range === undefined ? matches : [range]).map((candidate) => {
    const bounded = candidate === range;
    const before = sourceRolePrefix(source, candidate, matches);
    const role = (hasDependentDateNeighbor(source, candidate, [...matches, ...unresolved]) ||
      hasUnresolvedEndpointExclusion(source, candidate) ||
      /^\s*[,，]?\s*(?:or\b|或)/iu.test(source.slice(candidate.end)) ||
      /^(?:\s+(?:or|and|to|through|until)\s+(?:the\s+year\s+)?\d|\s*(?:或|和|至|到)\s*\d)/iu.test(source.slice(candidate.end)))
      ? "unknown"
      : sourceTemporalRole(before,
        source.slice(candidate.end, candidate.end + 8), bounded);
    return Object.freeze({ ...candidate, role, bounded });
  });
  return candidates.some((candidate) => candidate.role === "unknown") ? [] : candidates;
}

function sourceRangeMatch(source: string, matches: readonly TemporalMatch[]): TemporalMatch | undefined {
  if (matches.length !== 2) return undefined;
  const [left, right] = matches;
  const connector = source.slice(left!.end, right!.start);
  if (!/^\s*(?:to|through|[-–—]|至|到)\s*$/iu.test(connector)) return undefined;
  const start = left!.projection.event_time_start;
  const end = right!.projection.event_time_end;
  if (Date.parse(start) > Date.parse(end)) return undefined;
  return Object.freeze({
    start: left!.start, end: right!.end,
    projection: Object.freeze({
      projection_schema_version: 1,
      event_time_start: start, event_time_end: end, time_precision: "range",
      time_source: left!.projection.time_source === "explicit" && right!.projection.time_source === "explicit"
        ? "explicit" : "relative_resolved"
    })
  });
}

function hasDependentDateNeighbor(source: string, candidate: TemporalMatch, matches: readonly TemporalSpan[]): boolean {
  return matches.some((other) => {
    if (other === candidate) return false;
    const between = other.end <= candidate.start ? source.slice(other.end, candidate.start)
      : candidate.end <= other.start ? source.slice(candidate.end, other.start) : undefined;
    return between !== undefined && /^\s*(?:(?:or|and|to|through|until|[-–—]|至|到|或|和)\s*)?(?:(?:in|on|during|from|before|after|the\s+year)\s*)?$/iu.test(between);
  });
}

function sourceTemporalRole(before: string, after: string, bounded: boolean): SourceTemporalCandidate["role"] {
  // These name an inequality, not occurrence within the mentioned calendar
  // window. A validity cue cannot override an unresolved inequality either.
  if (/\b(?:before|after|by)\s+(?:the\s+year\s+)?$/iu.test(before) || /^(?:之前|之后|以前|以后|前|后)/u.test(after)) return "unknown";
  if (!bounded && /\b(?:until|through)\s*$|(?:截至|直到)$/iu.test(before)) return "unknown";
  if (hasValidityConstruction(before)) return "validity";
  if (!bounded && /\b(?:from|to)\s+(?:the\s+year\s+)?$|(?:自|从|到|至)$/iu.test(before)) return "unknown";
  return "event";
}

function hasValidityConstruction(before: string): boolean {
  // The construction must govern this date directly; a role word elsewhere
  // in the clause (for example an adjective) cannot supply temporal validity.
  return /\b(?:(?:effective|valid|in\s+effect|appl(?:y|ies))(?:\s+(?:from|since|on))?|since|as\s+of)\s+(?:the\s+year\s+)?$/iu.test(before) ||
    /(?:有效期|生效|有效|适用)\s*(?:自|从|起)?\s*$/u.test(before);
}

function hasUnresolvedEndpointExclusion(source: string, candidate: TemporalMatch): boolean {
  return /\b(?:exclusive|excluding|not\s+including)\b/iu.test(source.slice(candidate.start, candidate.end)) ||
    /^\s*[,;:]?\s*\(?\s*(?:exclusive\b|excluding\b|not\s+including\b)/iu.test(source.slice(candidate.end));
}

function sourceRolePrefix(source: string, candidate: TemporalMatch, matches: readonly TemporalMatch[]): string {
  const previous = [...matches].filter((match) => match.end <= candidate.start)
    .sort((left, right) => right.end - left.end)[0];
  // Role cues cannot cross the clause separating neighboring dates. With no
  // neighbor, retain the local clause so bounds on a date are not discarded.
  const earliest = Math.max(0, candidate.start - 96);
  const start = clauseStartAfter(source, previous?.end ?? earliest, candidate.start,
    previous === undefined ? earliest : candidate.start);
  return source.slice(start, candidate.start);
}

function clauseStartAfter(source: string, start: number, end: number, noBoundary: number): number {
  const separators = [...source.slice(start, end).matchAll(ROLE_CLAUSE_SEPARATOR)];
  const separator = separators[separators.length - 1];
  return separator === undefined ? noBoundary : start + separator.index + separator[0].length;
}
