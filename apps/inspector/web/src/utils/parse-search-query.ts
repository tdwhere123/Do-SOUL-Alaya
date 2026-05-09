import * as chrono from "chrono-node";

export interface ParsedSearchQuery {
  /** Free-text remainder after time expressions are stripped. */
  readonly text: string;
  /** ISO datetime lower bound (UTC `Z` suffix) or null for open-ended. */
  readonly since: string | null;
  /** ISO datetime upper bound (UTC `Z` suffix) or null for open-ended. */
  readonly until: string | null;
  /** Display label of the parsed window, e.g. "May 20, 2026" or null when no time expression matched. */
  readonly windowLabel: string | null;
}

const ZH_DAY_PATTERNS: ReadonlyArray<{
  readonly regex: RegExp;
  readonly resolve: (match: RegExpExecArray, refDate: Date) => { readonly year: number; readonly month: number; readonly day: number; readonly label: string } | null;
}> = [
  // "今天", "昨天", "前天", "明天", "后天"
  {
    regex: /(今天|昨天|前天|明天|后天)/,
    resolve: (m, ref) => {
      const offsets: Record<string, number> = { 今天: 0, 昨天: -1, 前天: -2, 明天: 1, 后天: 2 };
      const offset = offsets[m[1]!]!;
      const d = new Date(ref);
      d.setDate(d.getDate() + offset);
      return {
        year: d.getFullYear(),
        month: d.getMonth() + 1,
        day: d.getDate(),
        label: m[1]!
      };
    }
  },
  // "5月20号", "5月20日", "12月3号"
  {
    regex: /(\d{1,2})月(\d{1,2})[号日]/,
    resolve: (m, ref) => {
      const month = Number.parseInt(m[1]!, 10);
      const day = Number.parseInt(m[2]!, 10);
      if (month < 1 || month > 12 || day < 1 || day > 31) return null;
      return {
        year: ref.getFullYear(),
        month,
        day,
        label: `${month}月${day}日`
      };
    }
  }
];

const ZH_RELATIVE_RANGES: ReadonlyArray<{
  readonly regex: RegExp;
  readonly resolve: (refDate: Date) => { readonly since: Date; readonly until: Date; readonly label: string };
}> = [
  {
    regex: /上周/,
    resolve: (ref) => {
      // Last week = previous Mon..Sun.
      const day = ref.getDay(); // 0=Sun
      const mondayOfThisWeek = new Date(ref);
      mondayOfThisWeek.setHours(0, 0, 0, 0);
      mondayOfThisWeek.setDate(ref.getDate() - ((day + 6) % 7));
      const since = new Date(mondayOfThisWeek);
      since.setDate(since.getDate() - 7);
      const until = new Date(mondayOfThisWeek);
      until.setMilliseconds(-1);
      return { since, until, label: "上周" };
    }
  },
  {
    regex: /本周|这周/,
    resolve: (ref) => {
      const day = ref.getDay();
      const since = new Date(ref);
      since.setHours(0, 0, 0, 0);
      since.setDate(since.getDate() - ((day + 6) % 7));
      const until = new Date(since);
      until.setDate(until.getDate() + 7);
      until.setMilliseconds(-1);
      return { since, until, label: "本周" };
    }
  },
  {
    regex: /上个?月/,
    resolve: (ref) => {
      const since = new Date(ref.getFullYear(), ref.getMonth() - 1, 1, 0, 0, 0, 0);
      const until = new Date(ref.getFullYear(), ref.getMonth(), 1, 0, 0, 0, -1);
      return { since, until, label: "上月" };
    }
  },
  {
    regex: /这个?月|本月/,
    resolve: (ref) => {
      const since = new Date(ref.getFullYear(), ref.getMonth(), 1, 0, 0, 0, 0);
      const until = new Date(ref.getFullYear(), ref.getMonth() + 1, 1, 0, 0, 0, -1);
      return { since, until, label: "本月" };
    }
  }
];

/**
 * Parse a free-form search box query into a text fragment and an optional
 * time window. Supports English chrono expressions ("yesterday", "May 20",
 * "last week") via chrono-node, and a curated zh-CN set ("昨天", "5月20号",
 * "上周", "本月") via local regex resolvers because chrono-node's Chinese
 * coverage is incomplete.
 *
 * Returns identity fallback `{ text, since: null, until: null, windowLabel: null }`
 * when no time expression is recognised so the caller can run pure keyword
 * search without re-parsing.
 */
export function parseSearchQuery(input: string, now: Date = new Date()): ParsedSearchQuery {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { text: "", since: null, until: null, windowLabel: null };
  }

  // Multi-day relative ranges win over single-day patterns when both match.
  // Otherwise "5月20号 上周" silently collapses to a single-day window and
  // the operator's "上周" intent disappears.
  for (const range of ZH_RELATIVE_RANGES) {
    const match = range.regex.exec(trimmed);
    if (!match) continue;
    const resolved = range.resolve(now);
    return {
      text: stripMatch(trimmed, match),
      since: resolved.since.toISOString(),
      until: resolved.until.toISOString(),
      windowLabel: resolved.label
    };
  }

  for (const matcher of ZH_DAY_PATTERNS) {
    const match = matcher.regex.exec(trimmed);
    if (!match) continue;
    const resolved = matcher.resolve(match, now);
    if (!resolved) continue;
    const since = new Date(resolved.year, resolved.month - 1, resolved.day, 0, 0, 0, 0);
    const until = new Date(resolved.year, resolved.month - 1, resolved.day, 23, 59, 59, 999);
    return {
      text: stripMatch(trimmed, match),
      since: since.toISOString(),
      until: until.toISOString(),
      windowLabel: resolved.label
    };
  }

  // Fall through to chrono-node for English expressions.
  try {
    const results = chrono.parse(trimmed, now, { forwardDate: false });
    if (results.length > 0) {
      const first = results[0]!;
      const startDate = first.start?.date();
      const endDate = first.end?.date() ?? null;
      if (startDate) {
        const since = startDate;
        const until = endDate ?? endOfDay(startDate);
        const stripStart = first.index;
        const stripEnd = first.index + first.text.length;
        const cleaned = (trimmed.slice(0, stripStart) + trimmed.slice(stripEnd)).trim();
        return {
          text: cleaned,
          since: since.toISOString(),
          until: until.toISOString(),
          windowLabel: first.text
        };
      }
    }
  } catch {
    // chrono-node failure is non-fatal; fall through to keyword-only.
  }

  return { text: trimmed, since: null, until: null, windowLabel: null };
}

function stripMatch(input: string, match: RegExpExecArray): string {
  return (input.slice(0, match.index) + input.slice(match.index + match[0].length)).trim();
}

function endOfDay(start: Date): Date {
  const end = new Date(start);
  end.setHours(23, 59, 59, 999);
  return end;
}
