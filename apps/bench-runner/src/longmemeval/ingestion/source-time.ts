const SOURCE_DATE_PATTERN =
  /^(\d{4})[/-](\d{2})[/-](\d{2})(?:\s+\([^)]*\))?(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/u;
const CANONICAL_ISO_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export function normalizeCompileSeedSourceTime(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (CANONICAL_ISO_PATTERN.test(trimmed)) {
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) || parsed.toISOString() !== trimmed
      ? undefined
      : trimmed;
  }
  const match = SOURCE_DATE_PATTERN.exec(trimmed);
  if (match === null) return undefined;
  const parts = match.slice(1).map((part) => Number(part ?? 0));
  const [year, month, day, hour, minute, second] = parts;
  if (year === undefined || month === undefined || day === undefined) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return matchesUtcParts(date, parts) ? date.toISOString() : undefined;
}

export function requireLongMemEvalTimestamp(value: string | undefined): string {
  const normalized = normalizeCompileSeedSourceTime(value);
  if (normalized === undefined) {
    throw new Error(`invalid LongMemEval timestamp: ${JSON.stringify(value)}`);
  }
  return normalized;
}

export function assertLongMemEvalTimeline(input: {
  readonly haystack_sessions: readonly unknown[];
  readonly haystack_session_ids: readonly string[];
  readonly haystack_dates: readonly string[];
}): void {
  const count = input.haystack_sessions.length;
  if (input.haystack_session_ids.length !== count || input.haystack_dates.length !== count) {
    throw new Error("LongMemEval timeline arrays must have equal lengths.");
  }
  input.haystack_dates.forEach((value) => requireLongMemEvalTimestamp(value));
}

function matchesUtcParts(date: Date, parts: readonly number[]): boolean {
  return date.getUTCFullYear() === parts[0] &&
    date.getUTCMonth() + 1 === parts[1] &&
    date.getUTCDate() === parts[2] &&
    date.getUTCHours() === parts[3] &&
    date.getUTCMinutes() === parts[4] &&
    date.getUTCSeconds() === parts[5];
}
