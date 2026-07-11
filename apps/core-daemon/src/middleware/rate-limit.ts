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
}

const DEFAULT_RESPONSE_BODY = {
  success: false,
  error: "Rate limit exceeded"
} as const;

const CLEANUP_INTERVAL = 128;
const DEFAULT_MAX_BUCKETS = 4_096;
// When unique clients exceed maxBuckets, LRU eviction drops the oldest bucket
// and the next request from that client starts a fresh window — a deliberate
// memory cap tradeoff for local-first daemons under connection churn.

let rateLimitEvictionWarningEmitted = false;

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

    const key = options.resolveKey?.(context) ?? defaultRateLimitKey(context);
    const bucket = readBucket(buckets, key, now, options.windowMs);
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
  windowMs: number
): Bucket {
  const existing = buckets.get(key);
  if (existing === undefined || now - existing.startedAtMs >= windowMs) {
    const fresh = { startedAtMs: now, count: 0 };
    buckets.setWithEvictionNotice(key, fresh, (evictedKey, evictedBucket) => {
      if (now - evictedBucket.startedAtMs < windowMs && !rateLimitEvictionWarningEmitted) {
        rateLimitEvictionWarningEmitted = true;
        emitWarning(
          `rate-limit LRU evicted active bucket for key ${String(evictedKey)}; client may receive a fresh window`
        );
      }
    });
    return fresh;
  }

  return existing;
}

export function resolveProtectedRateLimitKey(context: Context): string {
  const token = normalizeHeader(context.req.header("x-request-token"));
  const socket = readSocketRemoteAddress(context) ?? "anonymous";
  if (token !== undefined) {
    return `token:${token}:${socket}`;
  }
  return socket;
}

function defaultRateLimitKey(context: Context): string {
  return resolveProtectedRateLimitKey(context);
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
