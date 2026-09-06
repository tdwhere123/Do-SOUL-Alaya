import { parseAbsoluteTemporalWindow, parseRelativeTemporalTerm } from "@do-soul/alaya-graph-algorithms";
import { isRelationValidityActiveAt, type RelationValidity } from "@do-soul/alaya-protocol";
import { hasTemporalQuerySignal } from "./recall-query-plan.js";
import type { RecallQueryProbes } from "./recall-query-probes.js";

export type RelationTemporalConstraint =
  | Readonly<{ kind: "as_of"; at: string }>
  | Readonly<{ kind: "before"; exclusiveEnd: string }>
  | Readonly<{ kind: "unsupported" }>;

export interface RelationQuery {
  readonly subject: string | null;
  readonly supported: boolean;
  readonly wantsChannel: boolean;
  readonly temporal: RelationTemporalConstraint;
}

export function compileRelationQuery(probes: Readonly<RecallQueryProbes>, asOf: string): RelationQuery {
  const text = probes.normalized_query ?? "";
  const subject = text.match(/(?:owns?\s+|owners? of\s+|owned\s+)([\p{L}\p{N}_-]+)/iu)?.[1]?.toLowerCase()
    ?? text.match(/^([\p{L}\p{N}_-]+) owner\b/iu)?.[1]?.toLowerCase() ?? null;
  let temporal: RelationTemporalConstraint = { kind: "as_of", at: asOf };
  if (hasTemporalQuerySignal(probes)) {
    const prefix = /^before\s+(.+?),?\s+(?:who|which)\b/iu.exec(text);
    const suffix = /\bbefore\s+([^?]+)\??$/iu.exec(text);
    const negatedOrCompound = /\b(?:not|never|unless|except|between|after|since|until|and|or)\b/iu.test(text);
    const dateText = !negatedOrCompound ? prefix?.[1] ?? suffix?.[1] : undefined;
    const boundary = dateText === undefined ? null : resolveDateBoundary(dateText.replace(/,\s*$/u, ""), asOf);
    temporal = boundary === null ? { kind: "unsupported" } : { kind: "before", exclusiveEnd: boundary };
  }
  const supported = !/\b(?:not|never|no|unless|except)\b|n[’']t\b/iu.test(text);
  return Object.freeze({ subject, supported, wantsChannel: /escalation channel/iu.test(text), temporal: Object.freeze(temporal) });
}

function resolveDateBoundary(text: string, asOf: string): string | null {
  const absolute = parseAbsoluteTemporalWindow(text);
  if (absolute) return new Date(absolute.startMs).toISOString();
  const namedDay = /^(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?$/iu.exec(text);
  if (!namedDay) return null;
  const month = parseRelativeTemporalTerm(`in ${namedDay[1]!}`);
  if (!month || month.kind !== "named_month") return null;
  const year = namedDay[3] ?? String(new Date(asOf).getUTCFullYear());
  const iso = `${year}-${String(month.month0 + 1).padStart(2, "0")}-${namedDay[2]!.padStart(2, "0")}`;
  const day = parseAbsoluteTemporalWindow(iso);
  return day ? new Date(day.startMs).toISOString() : null;
}

// A before constraint asks for observed validity intersecting (-infinity, end),
// not the latest owner or an invented single instant immediately before end.
export function relationMatchesTemporal(validity: RelationValidity, constraint: RelationTemporalConstraint): boolean {
  if (constraint.kind === "unsupported") return false;
  if (constraint.kind === "as_of") return isRelationValidityActiveAt(validity, constraint.at, new Set());
  if (validity.kind === "timeless") return false;
  return Date.parse(validity.valid_from) < Date.parse(constraint.exclusiveEnd);
}
