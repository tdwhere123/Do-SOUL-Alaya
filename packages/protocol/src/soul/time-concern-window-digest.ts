const TIME_CONCERN_WINDOW_DIGEST_PREFIX = "time_window_v1";
const TIME_CONCERN_WINDOW_DIGEST_PATTERN = /^time_window_v1:(-?\d+):(-?\d+)$/u;

type TemporalWindow = Readonly<{
  readonly startMs: number;
  readonly endMs: number;
}>;

export function createTimeConcernWindowDigest(
  start: string | number,
  end: string | number
): string {
  const startMs = parseTime(start);
  const endMs = parseTime(end);
  if (startMs === null || endMs === null || startMs > endMs) {
    throw new Error("time concern window requires a valid ordered interval");
  }
  return `${TIME_CONCERN_WINDOW_DIGEST_PREFIX}:${startMs}:${endMs}`;
}

export function normalizeTimeConcernWindowDigest(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, "_");
}

export function timeConcernWindowDigestsMatch(left: string, right: string): boolean {
  const normalizedLeft = normalizeTimeConcernWindowDigest(left);
  const normalizedRight = normalizeTimeConcernWindowDigest(right);
  if (normalizedLeft === normalizedRight) return true;
  const leftWindow = parseTimeConcernWindowDigest(normalizedLeft);
  const rightWindow = parseTimeConcernWindowDigest(normalizedRight);
  return leftWindow !== null && rightWindow !== null &&
    leftWindow.startMs <= rightWindow.endMs && rightWindow.startMs <= leftWindow.endMs;
}

function parseTimeConcernWindowDigest(value: string): TemporalWindow | null {
  const match = TIME_CONCERN_WINDOW_DIGEST_PATTERN.exec(value);
  if (match === null) return null;
  const startMs = Number(match[1]);
  const endMs = Number(match[2]);
  return Number.isSafeInteger(startMs) && Number.isSafeInteger(endMs) && startMs <= endMs
    ? Object.freeze({ startMs, endMs })
    : null;
}

function parseTime(value: string | number): number | null {
  const parsed = typeof value === "number" ? value : Date.parse(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
