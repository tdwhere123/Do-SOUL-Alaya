import { CoreError } from "./errors.js";

export type NowProvider = () => string;

export function systemNow(): string {
  return new Date().toISOString();
}

export function ensureIsoDatetime(value: string, fieldName: string): string {
  const epoch = Date.parse(value);

  if (!Number.isFinite(epoch)) {
    throw new CoreError("VALIDATION", `${fieldName} must return a valid ISO timestamp`);
  }

  return new Date(epoch).toISOString();
}

export function readNow(now?: NowProvider, fieldName = "now"): string {
  return ensureIsoDatetime(now?.() ?? systemNow(), fieldName);
}

export function readClockSnapshot(
  now?: NowProvider,
  fieldName = "now"
): Readonly<{
  readonly iso: string;
  readonly epochMs: number;
}> {
  const iso = readNow(now, fieldName);
  return Object.freeze({
    iso,
    epochMs: Date.parse(iso)
  });
}

export function addDuration(iso: string, durationMs: number): string {
  const epoch = Date.parse(iso);

  if (!Number.isFinite(epoch)) {
    throw new CoreError("VALIDATION", "now must return a valid ISO timestamp");
  }

  return new Date(epoch + durationMs).toISOString();
}

/**
 * Returns whether `expiresAt` is at or before `referenceTime`.
 *
 * - `null` expiresAt is not expired (no timestamp bound).
 * - Unparseable expiresAt is treated as expired so corrupt stored data cannot
 *   retain validity.
 * - Unparseable referenceTime throws because the reference clock must be valid.
 */
export function isExpired(expiresAt: string | null, referenceTime: string): boolean {
  if (expiresAt === null) {
    return false;
  }

  const expiryEpoch = Date.parse(expiresAt);
  const referenceEpoch = Date.parse(referenceTime);

  if (!Number.isFinite(referenceEpoch)) {
    throw new CoreError("VALIDATION", "referenceTime must be a valid ISO timestamp");
  }

  if (!Number.isFinite(expiryEpoch)) {
    return true;
  }

  return expiryEpoch <= referenceEpoch;
}
