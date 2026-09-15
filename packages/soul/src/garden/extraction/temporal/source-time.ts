import { resolveTemporalProjection, timeConcernPattern, type TemporalProjection } from "../time-concern-projection.js";

const ROLE_CLAUSE_SEPARATOR =
  /(?:[;,.!?\n；，。！？]+|\b(?:and|but|while|whereas|then)\b|(?:并且|而|但|然后|同时))/giu;
// These locate possible arguments, not accepted dates. Unparsed words remain
// evidence of uncertainty without extending the calendar parser's grammar.
const TEMPORAL_ARGUMENT_PREFIX_SOURCE = String.raw`(?:\b(?:in|on|during|from|since|before|after|until|through|to|by)\s+(?:the\s+year\s+)?|\bthe\s+year\s+|(?:在|于|自|从|到|至))`;
const TEMPORAL_ARGUMENT_PREFIX = new RegExp(TEMPORAL_ARGUMENT_PREFIX_SOURCE, "giu");
const TEMPORAL_CLAUSE_BOUNDARY_SOURCE = String.raw`(?:[;!?\n；，。！？]+|[,.](?=\s|$)|\b(?:and|but|while|whereas|then)\b|(?:和|并且|而|但|然后|同时))`;
const TEMPORAL_ARGUMENT_BOUNDARY = new RegExp(`${TEMPORAL_CLAUSE_BOUNDARY_SOURCE}|\\b(?:or|to|through|until)\\b|(?:或|至|到)`, "giu");
const TEMPORAL_DEPENDENCY_GAP = new RegExp(String.raw`^\s*[,，]?\s*(?:(?:or|and|to|through|until|[-–—]|至|到|或|和)\s*)?(?:${TEMPORAL_ARGUMENT_PREFIX_SOURCE})?\s*$`, "iu");
const PRECEDING_TEMPORAL_ALTERNATIVE = new RegExp(String.raw`(?:\bor\s+|或\s*)(?:${TEMPORAL_ARGUMENT_PREFIX_SOURCE})?$`, "iu");
const TEMPORAL_RANGE_OPENING = /\b(?:from|since)\s+(?:the\s+year\s+)?$|(?:自|从)\s*$/iu;
const TEMPORAL_RANGE_CONNECTOR = /\b(?:to|through|until)\b|至|到/iu;

export interface SourceTemporalCandidate {
  readonly start: number;
  readonly end: number;
  readonly projection: TemporalProjection;
  readonly role: "event" | "validity" | "unknown";
  readonly bounded: boolean;
}

type TemporalMatch = Pick<SourceTemporalCandidate, "start" | "end" | "projection">;
type TemporalSpan = Pick<SourceTemporalCandidate, "start" | "end">;
type TemporalArgument = TemporalSpan & Readonly<{ rangeStart: boolean }>;

/** Source inventory, range binding and role interpretation share one owner. */
export function resolveSourceTemporalCandidates(
  source: string,
  anchor: string | undefined
): readonly SourceTemporalCandidate[] {
  const { arguments_, matches, unresolved } = sourceTemporalInventory(source, anchor);
  const calendarEvidence = [...matches, ...unresolved];
  const range = sourceRangeMatch(source, matches);
  const candidates = (range === undefined ? matches : [range]).map((candidate) => {
    const bounded = candidate === range;
    const before = sourceRolePrefix(source, candidate, calendarEvidence);
    const opensRange = !bounded && (TEMPORAL_RANGE_OPENING.test(before) || hasValidityConstruction(before));
    const role = (hasUnresolvedTemporalDependency(source, temporalDependencyExtent(candidate, arguments_),
      calendarEvidence, arguments_, opensRange) ||
      PRECEDING_TEMPORAL_ALTERNATIVE.test(before) ||
      hasUnresolvedEndpointExclusion(source, candidate) ||
      /^\s*[,，]?\s*(?:or\b|或)/iu.test(source.slice(candidate.end)) ||
      /^(?:\s+(?:or|and|to|through|until)\s+(?:the\s+year\s+)?\d|\s*(?:或|和|至|到)\s*\d)/iu.test(source.slice(candidate.end)) ||
      (opensRange && /^\s*(?:to\b|through\b|until\b|至|到)/iu.test(source.slice(candidate.end))))
      ? "unknown"
      : sourceTemporalRole(before,
        source.slice(candidate.end, candidate.end + 96), bounded);
    return Object.freeze({ ...candidate, role, bounded });
  });
  return candidates.some((candidate) => candidate.role === "unknown") ? [] : candidates;
}

function sourceTemporalArguments(source: string): readonly TemporalArgument[] {
  const boundaries = [...source.matchAll(TEMPORAL_ARGUMENT_BOUNDARY)];
  const arguments_: TemporalArgument[] = [];
  let boundaryIndex = 0;
  for (const prefix of source.matchAll(TEMPORAL_ARGUMENT_PREFIX)) {
    const start = prefix.index + prefix[0].length;
    while (boundaries[boundaryIndex] !== undefined && boundaries[boundaryIndex]!.index < start) boundaryIndex += 1;
    let end = boundaries[boundaryIndex]?.index ?? source.length;
    while (end > start && /\s/u.test(source[end - 1]!)) end -= 1;
    if (end > start) arguments_.push({ start, end, rangeStart: TEMPORAL_RANGE_OPENING.test(prefix[0]) });
  }
  return arguments_;
}

function temporalDependencyExtent(candidate: TemporalSpan, arguments_: readonly TemporalSpan[]): TemporalSpan {
  // The closest governing argument preserves adjuncts between its date and a
  // connector. Wider overlapping arguments must not hide an inner validity cue.
  const starting = arguments_.filter((span) => span.start <= candidate.start && candidate.start < span.end).at(-1);
  const ending = arguments_.filter((span) => span.start < candidate.end && candidate.end <= span.end).at(-1);
  return { start: starting?.start ?? candidate.start, end: ending?.end ?? candidate.end };
}

function sourceTemporalInventory(source: string, anchor: string | undefined): {
  readonly arguments_: readonly TemporalArgument[];
  readonly matches: readonly TemporalMatch[];
  readonly unresolved: readonly TemporalSpan[];
} {
  // Argument discovery precedes calendar acceptance. An unknown word or
  // format can still be a branch of the same temporal alternative/range.
  const arguments_ = sourceTemporalArguments(source);
  const matches: TemporalMatch[] = [];
  const unresolved: TemporalSpan[] = [];
  const discovered = [...source.matchAll(timeConcernPattern())].map((match) => {
    const span = temporalLexicalExtent(source, match.index, match.index + match[0].length);
    const projection = resolveTemporalProjection(match[0], anchor ?? null);
    // Year discovery includes its preposition; role/range binding needs the
    // actual date span, just as month/day discovery does.
    const yearOffset = projection?.time_precision === "year" && projection.time_source === "explicit"
      ? match[0].search(/[1-9]\d{3}/u) : 0;
    return { span, lexeme: { start: match.index, end: match.index + match[0].length },
      candidate: projection === null ? undefined : {
        start: match.index + Math.max(0, yearOffset), end: match.index + match[0].length, projection } };
  });
  // Compact closed ranges are whole calendar units. Let the existing range
  // owner establish their two endpoints before treating the dash as attachment.
  const range = sourceRangeMatch(source, discovered.flatMap((row) => row.candidate ?? []));
  const completeRange = range !== undefined && discovered.every(({ span, lexeme, candidate }) =>
    candidate !== undefined && ((span.start === lexeme.start && span.end === lexeme.end) ||
      (span.start === range.start && span.end === range.end)));
  for (const { span, lexeme, candidate } of discovered) {
    // Preserve rejected branches before interpreting their dependencies. A
    // matched calendar prefix is not evidence for the complete attached token.
    const complete = span.start === lexeme.start && span.end === lexeme.end;
    // Endpoint eligibility is atomic: a range used as evidence cannot then lose
    // one rejected endpoint and publish its survivor as a standalone date.
    if (candidate === undefined || (range !== undefined ? !completeRange : !complete)) {
      unresolved.push(span);
      continue;
    }
    matches.push(candidate);
  }
  return { arguments_, matches, unresolved };
}

function temporalLexicalExtent(source: string, start: number, end: number): TemporalSpan {
  // An attached identifier, compound or possessive belongs to a larger unit,
  // not a standalone calendar adjunct. Outer quotation alone is not attachment.
  while (start > 0 && /[a-z\d_/\-‐‑–—]/iu.test(source[start - 1]!)) start -= 1;
  while (end < source.length && /[a-z\d_/\-‐‑–—]/iu.test(source[end]!)) end += 1;
  const modifier = /^(?:['’]s|的)/iu.exec(source.slice(end));
  if (modifier !== null) end += modifier[0].length;
  while (end < source.length && /[a-z\d_/\-‐‑–—]/iu.test(source[end]!)) end += 1;
  return { start, end };
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

function hasUnresolvedTemporalDependency(
  source: string, candidate: TemporalSpan, calendarEvidence: readonly TemporalSpan[],
  arguments_: readonly TemporalArgument[], opensRange: boolean
): boolean {
  return [...calendarEvidence, ...arguments_].some((other) => {
    const between = other.end <= candidate.start ? source.slice(other.end, candidate.start)
      : candidate.end <= other.start ? source.slice(candidate.end, other.start) : undefined;
    if (between === undefined) return false;
    if (!("rangeStart" in other)) return TEMPORAL_DEPENDENCY_GAP.test(between);
    // A choice or range between raw temporal arguments survives all unparsed
    // gap text. Punctuation and conjunctions inside that text cannot prove
    // independence; this bounded owner abstains instead of guessing a clause.
    if (/\bor\b|或/iu.test(between)) return true;
    // An arbitrary `to` may introduce a purpose or object. Only a governing
    // range opening (or the calendar evidence above) can make it an endpoint.
    const leftOpensRange = other.end <= candidate.start ? other.rangeStart : opensRange;
    return leftOpensRange && TEMPORAL_RANGE_CONNECTOR.test(between);
  });
}

function sourceTemporalRole(before: string, after: string, bounded: boolean): SourceTemporalCandidate["role"] {
  // These name an inequality, not occurrence within the mentioned calendar
  // window. A validity cue cannot override an unresolved inequality either.
  if (/\b(?:before|after|by)\s+(?:the\s+year\s+)?$/iu.test(before) || /^(?:之前|之后|以前|以后|前|后)/u.test(after)) return "unknown";
  if (!bounded && /\b(?:until|through)\s*$|(?:截至|直到)$/iu.test(before)) return "unknown";
  if (hasValidityConstruction(before) || hasTrailingValidityConstruction(after)) return "validity";
  if (!bounded && /\b(?:from|to)\s+(?:the\s+year\s+)?$|(?:自|从|到|至)$/iu.test(before)) return "unknown";
  return "event";
}

function hasValidityConstruction(before: string): boolean {
  // The construction must govern this date directly; a role word elsewhere
  // in the clause (for example an adjective) cannot supply temporal validity.
  return /\b(?:(?:effective|valid|in\s+effect|appl(?:y|ies))(?:\s+(?:from|since|on))?|since|as\s+of)\s+(?:the\s+year\s+)?$/iu.test(before) ||
    /(?:有效期|生效|有效|适用)\s*(?:自|从|起)?\s*$/u.test(before);
}

function hasTrailingValidityConstruction(after: string): boolean {
  // Copula after the date names that date as the validity bound. A later
  // clause or a descriptive adjective must not supply the role.
  return /^\s+(?:was|is)\s+the\s+(?:effective|valid)\s+date\b/iu.test(after);
}

function hasUnresolvedEndpointExclusion(source: string, candidate: TemporalMatch): boolean {
  return /\b(?:exclusive|excluding|not\s+including)\b/iu.test(source.slice(candidate.start, candidate.end)) ||
    /^\s*[,;:]?\s*\(?\s*(?:exclusive\b|excluding\b|not\s+including\b)/iu.test(source.slice(candidate.end));
}

function sourceRolePrefix(source: string, candidate: TemporalMatch, matches: readonly TemporalSpan[]): string {
  const previous = [...matches].filter((match) => match.end <= candidate.start)
    .sort((left, right) => right.end - left.end)[0];
  // Keep the intervening construction even when two dates share one clause;
  // a previous date is a lower bound on context, not proof of an empty prefix.
  const earliest = previous?.end ?? 0;
  const start = clauseStartAfter(source, earliest, candidate.start);
  return source.slice(start, candidate.start);
}

function clauseStartAfter(source: string, start: number, end: number): number {
  const separators = [...source.slice(start, end).matchAll(ROLE_CLAUSE_SEPARATOR)];
  const separator = separators[separators.length - 1];
  return separator === undefined ? start : start + separator.index + separator[0].length;
}
