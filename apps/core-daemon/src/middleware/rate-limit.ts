import type { Context, MiddlewareHandler } from "hono";

type Bucket = {
  startedAtMs: number;
  count: number;
};

export interface FixedWindowRateLimitOptions {
  readonly maxRequests: number;
  readonly windowMs: number;
  readonly nowMs?: () => number;
  readonly skip?: (context: Context) => boolean;
  readonly resolveKey?: (context: Context) => string;
}

const DEFAULT_RESPONSE_BODY = {
  success: false,
  error: "Rate limit exceeded"
} as const;

const CLEANUP_INTERVAL = 128;

export function createFixedWindowRateLimitMiddleware(
  options: FixedWindowRateLimitOptions
): MiddlewareHandler {
  const buckets = new Map<string, Bucket>();
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

function cleanupExpiredBuckets(
  buckets: Map<string, Bucket>,
  now: number,
  windowMs: number,
  requestsSinceCleanup: number
): void {
  if (requestsSinceCleanup < CLEANUP_INTERVAL) {
    return;
  }

  for (const [key, bucket] of buckets.entries()) {
    if (now - bucket.startedAtMs >= windowMs) {
      buckets.delete(key);
    }
  }
}

function readBucket(
  buckets: Map<string, Bucket>,
  key: string,
  now: number,
  windowMs: number
): Bucket {
  const existing = buckets.get(key);
  if (existing === undefined || now - existing.startedAtMs >= windowMs) {
    const fresh = { startedAtMs: now, count: 0 };
    buckets.set(key, fresh);
    return fresh;
  }

  return existing;
}

function defaultRateLimitKey(context: Context): string {
  const headers = [
    context.req.header("x-request-token"),
    readFirstForwardedValue(context.req.header("x-forwarded-for")),
    context.req.header("x-real-ip"),
    context.req.header("cf-connecting-ip")
  ];
  for (const value of headers) {
    const normalized = normalizeHeader(value);
    if (normalized !== undefined) {
      return normalized;
    }
  }

  return "anonymous";
}

function readFirstForwardedValue(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const first = value.split(",")[0];
  return first?.trim();
}

function normalizeHeader(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}
