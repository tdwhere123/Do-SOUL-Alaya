import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";

const DEFAULT_LAUNCH_FAILURE_LIMIT = 10;
const DEFAULT_LAUNCH_FAILURE_WINDOW_MS = 60_000;
const LAUNCH_SESSION_LOOPBACK_CLIENT_KEY = "loopback";

interface FailureBucket {
  startedAtMs: number;
  consecutiveFailures: number;
}

export interface LaunchSessionFailureLimiter {
  isLimited(clientKey: string): boolean;
  recordFailure(clientKey: string): void;
  reset(clientKey: string): void;
}

export interface LaunchSessionFailureLimiterOptions {
  readonly maxConsecutiveFailures?: number;
  readonly windowMs?: number;
  readonly nowMs?: () => number;
}

export function createLaunchSessionFailureLimiter(
  options: LaunchSessionFailureLimiterOptions = {}
): LaunchSessionFailureLimiter {
  const maxConsecutiveFailures = options.maxConsecutiveFailures ?? DEFAULT_LAUNCH_FAILURE_LIMIT;
  const windowMs = options.windowMs ?? DEFAULT_LAUNCH_FAILURE_WINDOW_MS;
  const nowMs = options.nowMs ?? Date.now;
  const buckets = new Map<string, FailureBucket>();

  return {
    isLimited(clientKey: string): boolean {
      const bucket = readActiveBucket(buckets, clientKey, nowMs(), windowMs);
      return bucket !== undefined && bucket.consecutiveFailures >= maxConsecutiveFailures;
    },
    recordFailure(clientKey: string): void {
      const now = nowMs();
      const existing = readActiveBucket(buckets, clientKey, now, windowMs);
      if (existing === undefined) {
        buckets.set(clientKey, { startedAtMs: now, consecutiveFailures: 1 });
        return;
      }
      existing.consecutiveFailures += 1;
    },
    reset(clientKey: string): void {
      buckets.delete(clientKey);
    }
  };
}

export function resolveLaunchSessionClientKey(context: Context): string {
  const remote = readSocketRemoteAddress(context);
  return remote ?? LAUNCH_SESSION_LOOPBACK_CLIENT_KEY;
}

function readActiveBucket(
  buckets: Map<string, FailureBucket>,
  clientKey: string,
  now: number,
  windowMs: number
): FailureBucket | undefined {
  const existing = buckets.get(clientKey);
  if (existing === undefined) {
    return undefined;
  }
  if (now - existing.startedAtMs >= windowMs) {
    buckets.delete(clientKey);
    return undefined;
  }
  return existing;
}

function readSocketRemoteAddress(context: Context): string | undefined {
  try {
    const address = getConnInfo(context).remote.address;
    return normalizeRemoteAddress(address);
  } catch {
    return undefined;
  }
}

function normalizeRemoteAddress(address: string | undefined): string | undefined {
  const trimmed = address?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return undefined;
  }
  return trimmed.startsWith("::ffff:") ? trimmed.slice("::ffff:".length) : trimmed;
}
