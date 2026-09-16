import { randomBytes } from "node:crypto";

const DEFAULT_LAUNCH_CODE_TTL_MS = 5 * 60 * 1000;
export const INSPECTOR_SESSION_TTL_MS = 15 * 60 * 1000;
export const INSPECTOR_SESSION_COOKIE = "alaya_inspector_session";
export const INSPECTOR_VITEST_SESSION_ID = "vitest-inspector-session";

interface LaunchCodeEntry {
  readonly expiresAtMs: number;
}

interface SessionEntry {
  readonly expiresAtMs: number;
}

export interface InspectorLaunchSessionStore {
  register(code: string, ttlMs?: number): void;
  redeem(code: string): string | null;
  hasSession(sessionId: string): boolean;
  seedSession(sessionId: string): void;
}

export function createInspectorLaunchSessionStore(
  clock: () => number = Date.now,
  sessionTtlMs: number = INSPECTOR_SESSION_TTL_MS
): InspectorLaunchSessionStore {
  const codes = new Map<string, LaunchCodeEntry>();
  const sessions = new Map<string, SessionEntry>();

  return {
    register(code: string, ttlMs: number = DEFAULT_LAUNCH_CODE_TTL_MS): void {
      const normalizedCode = normalizeSecret(code);
      if (normalizedCode === null) {
        return;
      }
      codes.set(normalizedCode, { expiresAtMs: clock() + ttlMs });
    },
    redeem(code: string): string | null {
      const normalizedCode = normalizeSecret(code);
      if (normalizedCode === null) {
        return null;
      }
      const entry = codes.get(normalizedCode);
      codes.delete(normalizedCode);
      if (entry === undefined || clock() > entry.expiresAtMs) {
        return null;
      }
      const sessionId = randomBytes(32).toString("hex");
      sessions.set(sessionId, { expiresAtMs: clock() + sessionTtlMs });
      return sessionId;
    },
    hasSession(sessionId: string): boolean {
      const normalized = normalizeSecret(sessionId);
      if (normalized === null) {
        return false;
      }
      const entry = sessions.get(normalized);
      if (entry === undefined) {
        return false;
      }
      if (clock() > entry.expiresAtMs) {
        sessions.delete(normalized);
        return false;
      }
      return true;
    },
    seedSession(sessionId: string): void {
      const normalized = normalizeSecret(sessionId);
      if (normalized === null) {
        return;
      }
      sessions.set(normalized, { expiresAtMs: clock() + sessionTtlMs });
    }
  };
}

function normalizeSecret(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
