const DEFAULT_LAUNCH_CODE_TTL_MS = 5 * 60 * 1000;

interface LaunchSessionEntry {
  readonly token: string;
  readonly expiresAtMs: number;
}

export interface InspectorLaunchSessionStore {
  register(code: string, token: string, ttlMs?: number): void;
  redeem(code: string): string | null;
}

export function createInspectorLaunchSessionStore(
  clock: () => number = Date.now
): InspectorLaunchSessionStore {
  const entries = new Map<string, LaunchSessionEntry>();

  return {
    register(code: string, token: string, ttlMs: number = DEFAULT_LAUNCH_CODE_TTL_MS): void {
      const normalizedCode = normalizeLaunchCode(code);
      const normalizedToken = token.trim();
      if (normalizedCode === null || normalizedToken.length === 0) {
        return;
      }
      entries.set(normalizedCode, {
        token: normalizedToken,
        expiresAtMs: clock() + ttlMs
      });
    },
    redeem(code: string): string | null {
      const normalizedCode = normalizeLaunchCode(code);
      if (normalizedCode === null) {
        return null;
      }
      const entry = entries.get(normalizedCode);
      entries.delete(normalizedCode);
      if (entry === undefined || clock() > entry.expiresAtMs) {
        return null;
      }
      return entry.token;
    }
  };
}

function normalizeLaunchCode(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
