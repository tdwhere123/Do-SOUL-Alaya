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

export type RateLimitDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "limited"; readonly retryAfterSeconds: number }
  | { readonly kind: "identity_unavailable" };

export interface FixedWindowRateLimiter {
  inspect(key: string): RateLimitDecision;
  consume(key: string): RateLimitDecision;
}

const DEFAULT_RESPONSE_BODY = {
  success: false,
  error: "Rate limit exceeded"
} as const;

const CLEANUP_INTERVAL = 128;
const DEFAULT_MAX_BUCKETS = 4_096;
const UNKNOWN_SOCKET_KEY = "__alaya_rate_limit_unknown_socket__";

export function createFixedWindowRateLimiter(
  options: Omit<FixedWindowRateLimitOptions, "skip" | "resolveKey">
): FixedWindowRateLimiter {
  const buckets = new LruCache<string, Bucket>(options.maxBuckets ?? DEFAULT_MAX_BUCKETS);
  const nowMs = options.nowMs ?? Date.now;
  const maxBuckets = options.maxBuckets ?? DEFAULT_MAX_BUCKETS;
  let requestsSinceCleanup = 0;

  const sweep = (): number => {
    requestsSinceCleanup += 1;
    const now = nowMs();
    cleanupExpiredBuckets(buckets, now, options.windowMs, requestsSinceCleanup);
    if (requestsSinceCleanup >= CLEANUP_INTERVAL) {
      requestsSinceCleanup = 0;
    }
    return now;
  };

  return {
    inspect(key: string): RateLimitDecision {
      return decide(buckets, key, sweep(), options.windowMs, options.maxRequests, maxBuckets, false);
    },
    consume(key: string): RateLimitDecision {
      return decide(buckets, key, sweep(), options.windowMs, options.maxRequests, maxBuckets, true);
    }
  };
}

export function createFixedWindowRateLimitMiddleware(
  options: FixedWindowRateLimitOptions
): MiddlewareHandler {
  const limiter = createFixedWindowRateLimiter(options);
  const failClosed = options.failClosedOnUnknownSocket === true;

  return async (context, next) => {
    if (options.skip?.(context) === true) {
      await next();
      return;
    }

    const key =
      options.resolveKey?.(context) ?? resolveProtectedRateLimitKey(context, failClosed);
    const decision = limiter.consume(key);
    const rejected = rateLimitRejection(context, decision);
    if (rejected !== undefined) {
      return rejected;
    }
    await next();
  };
}

export function rateLimitRejection(
  context: Context,
  decision: RateLimitDecision
): Response | undefined {
  if (decision.kind === "identity_unavailable") {
    return context.json({ success: false, error: "Rate limit identity unavailable" }, 403);
  }
  if (decision.kind === "limited") {
    context.header("retry-after", String(decision.retryAfterSeconds));
    return context.json(DEFAULT_RESPONSE_BODY, 429);
  }
  return undefined;
}

export function readSocketRemoteAddress(context: Context): string | undefined {
  try {
    const address = getConnInfo(context).remote.address;
    return normalizeRemoteAddress(address);
  } catch {
    return undefined;
  }
}

export function readUnixPeerCredentials(context: Context): string | undefined {
  try {
    const incoming = (context.env as { incoming?: { socket?: NodeJS.Socket } } | undefined)
      ?.incoming;
    const handle = (
      incoming?.socket as { _handle?: { getPeerCredentials?: () => UnixPeerCredentials } } | undefined
    )?._handle;
    const creds = handle?.getPeerCredentials?.();
    if (creds === undefined || !Number.isInteger(creds.uid) || !Number.isInteger(creds.pid)) {
      return undefined;
    }
    return `${creds.uid}:${creds.pid}`;
  } catch {
    return undefined;
  }
}

type UnixPeerCredentials = {
  readonly pid: number;
  readonly uid: number;
  readonly gid?: number;
};

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

function decide(
  buckets: LruCache<string, Bucket>,
  key: string,
  now: number,
  windowMs: number,
  maxRequests: number,
  maxBuckets: number,
  consume: boolean
): RateLimitDecision {
  if (key === UNKNOWN_SOCKET_KEY) {
    return { kind: "identity_unavailable" };
  }
  if (!consume) {
    const existing = buckets.get(key);
    if (existing === undefined || now - existing.startedAtMs >= windowMs) {
      return { kind: "allow" };
    }
    if (existing.count >= maxRequests) {
      return limitedDecision(windowMs, now, existing.startedAtMs);
    }
    return { kind: "allow" };
  }
  const bucket = readBucket(buckets, key, now, windowMs, maxBuckets);
  if (bucket === null) {
    return { kind: "limited", retryAfterSeconds: 1 };
  }
  if (bucket.count >= maxRequests) {
    return limitedDecision(windowMs, now, bucket.startedAtMs);
  }
  bucket.count += 1;
  return { kind: "allow" };
}

function limitedDecision(windowMs: number, now: number, startedAtMs: number): RateLimitDecision {
  return {
    kind: "limited",
    retryAfterSeconds: Math.max(1, Math.ceil((windowMs - (now - startedAtMs)) / 1000))
  };
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
    emitWarning(
      "rate-limit LRU is full of active buckets; refusing a new client instead of resetting counters"
    );
    return null;
  }
  const fresh = { startedAtMs: now, count: 0 };
  buckets.set(key, fresh);
  return fresh;
}

export function resolvePeerRateLimitKey(
  context: Context,
  failClosedOnUnknownSocket = false
): string {
  // Failed auth must not key by the attacker-chosen token or random tokens
  // fill the LRU and never share a bucket.
  const peercred = readUnixPeerCredentials(context);
  if (peercred !== undefined) {
    return `unix:${peercred}`;
  }
  const socket = readSocketRemoteAddress(context);
  if (socket === undefined && failClosedOnUnknownSocket) {
    return UNKNOWN_SOCKET_KEY;
  }
  return socket ?? "anonymous";
}

export function resolveProtectedRateLimitKey(
  context: Context,
  failClosedOnUnknownSocket = false
): string {
  const token = normalizeHeader(context.req.header("x-request-token"));
  const peer = resolvePeerRateLimitKey(context, failClosedOnUnknownSocket);
  if (peer === UNKNOWN_SOCKET_KEY) {
    return UNKNOWN_SOCKET_KEY;
  }
  if (token !== undefined) {
    return `token:${hashRateLimitCredential(token)}:${peer}`;
  }
  return peer;
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
