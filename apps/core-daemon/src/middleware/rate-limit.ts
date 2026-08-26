import { createHash } from "node:crypto";
import { emitWarning } from "node:process";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";
import { LruCache } from "./lru-cache.js";

type Bucket = {
  startedAtMs: number;
  count: number;
};

export interface FixedWindowRateLimitOptions {
  readonly maxRequests: number;
  readonly windowMs: number;
  readonly maxBuckets?: number;
  readonly nowMs?: () => number;
  readonly skip?: (context: Context) => boolean;
  readonly resolveKey?: (context: Context) => string;
  readonly failClosedOnUnknownSocket?: boolean;
}

const DEFAULT_RESPONSE_BODY = {
  success: false,
  error: "Rate limit exceeded"
} as const;

const CLEANUP_INTERVAL = 128;
const DEFAULT_MAX_BUCKETS = 4_096;
const UNKNOWN_SOCKET_KEY = "__alaya_rate_limit_unknown_socket__";

export function createFixedWindowRateLimitMiddleware(
  options: FixedWindowRateLimitOptions
): MiddlewareHandler {
  const buckets = new LruCache<string, Bucket>(options.maxBuckets ?? DEFAULT_MAX_BUCKETS);
  const nowMs = options.nowMs ?? Date.now;
  let requestsSinceCleanup = 0;

  return async (context, next) => {
    if (options.skip?.(context) === true) {
      await next();
      return;
    }

    requestsSinceCleanup += 1;
    const now = nowMs();
    cleanupExpiredBuckets(buckets, now, options.windowMs, requestsSinceCleanup);
    if (requestsSinceCleanup >= CLEANUP_INTERVAL) {
      requestsSinceCleanup = 0;
    }

    const key = options.resolveKey?.(context)
      ?? resolveProtectedRateLimitKey(context, options.failClosedOnUnknownSocket === true);
    if (key === UNKNOWN_SOCKET_KEY) {
      return context.json({ success: false, error: "Rate limit identity unavailable" }, 403);
    }
    const bucket = readBucket(
      buckets,
      key,
      now,
      options.windowMs,
      options.maxBuckets ?? DEFAULT_MAX_BUCKETS
    );
    if (bucket === null) {
      return context.json(DEFAULT_RESPONSE_BODY, 429);
    }
    if (bucket.count >= options.maxRequests) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((options.windowMs - (now - bucket.startedAtMs)) / 1000)
      );
      context.header("retry-after", String(retryAfterSeconds));
      return context.json(DEFAULT_RESPONSE_BODY, 429);
    }

    bucket.count += 1;
    await next();
  };
}

export function readSocketRemoteAddress(context: Context): string | undefined {
  try {
    const address = getConnInfo(context).remote.address;
    return normalizeRemoteAddress(address);
  } catch {
    return undefined;
  }
}

function cleanupExpiredBuckets(
  buckets: LruCache<string, Bucket>,
  now: number,
  windowMs: number,
  requestsSinceCleanup: number
): void {
  if (requestsSinceCleanup < CLEANUP_INTERVAL) {
    return;
  }

  buckets.forEach((bucket, key) => {
    if (now - bucket.startedAtMs >= windowMs) {
      buckets.delete(key);
    }
  });
}

function readBucket(
  buckets: LruCache<string, Bucket>,
  key: string,
  now: number,
  windowMs: number,
  maxBuckets: number
): Bucket | null {
  const existing = buckets.get(key);
  if (existing !== undefined && now - existing.startedAtMs < windowMs) {
    return existing;
  }
  if (existing !== undefined) {
    const fresh = { startedAtMs: now, count: 0 };
    buckets.set(key, fresh);
    return fresh;
  }
  if (buckets.size >= maxBuckets) {
    emitWarning("rate-limit LRU is full of active buckets; refusing a new client instead of resetting counters");
    return null;
  }
  const fresh = { startedAtMs: now, count: 0 };
  buckets.set(key, fresh);
  return fresh;
}

export function resolveProtectedRateLimitKey(
  context: Context,
  failClosedOnUnknownSocket = false
): string {
  const token = normalizeHeader(context.req.header("x-request-token"));
  const socket = readSocketRemoteAddress(context);
  if (socket === undefined && failClosedOnUnknownSocket) {
    return UNKNOWN_SOCKET_KEY;
  }
  const identity = socket ?? "anonymous";
  if (token !== undefined) {
    return `token:${hashRateLimitCredential(token)}:${identity}`;
  }
  return identity;
}

function hashRateLimitCredential(credential: string): string {
  return createHash("sha256").update(credential).digest("hex").slice(0, 16);
}

function normalizeRemoteAddress(address: string | undefined): string | undefined {
  const trimmed = address?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return undefined;
  }

  return trimmed.startsWith("::ffff:") ? trimmed.slice("::ffff:".length) : trimmed;
}

function normalizeHeader(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}
