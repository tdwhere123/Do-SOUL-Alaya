import type { Hono } from "hono";
import {
  createFixedWindowRateLimitMiddleware,
  resolveProtectedRateLimitKey
} from "./rate-limit.js";
import { createApiSecurityHeadersMiddleware } from "./security-headers.js";

const LIVENESS_PATH = "/health";
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT_MAX_REQUESTS = 600;

export interface CoreDaemonRateLimitConfig {
  readonly maxRequests?: number;
  readonly windowMs?: number;
  readonly nowMs?: () => number;
}

export function registerSecurityHeadersMiddleware(app: Hono): void {
  app.use("*", createApiSecurityHeadersMiddleware());
}

export function registerRateLimitMiddleware(
  app: Hono,
  config: CoreDaemonRateLimitConfig | undefined
): void {
  // Fixed-window cap on protected routes; /health exempt.
  // see also: resolveProtectedRateLimitKey — loopback anonymous socket bucket.
  app.use(
    "*",
    createFixedWindowRateLimitMiddleware({
      maxRequests: config?.maxRequests ?? DEFAULT_RATE_LIMIT_MAX_REQUESTS,
      windowMs: config?.windowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS,
      ...(config?.nowMs === undefined ? {} : { nowMs: config.nowMs }),
      skip: (context) => !isProtectedRequest(context.req.method, context.req.path),
      resolveKey: resolveProtectedRateLimitKey
    })
  );
}

export function isProtectedRequest(method: string, path: string): boolean {
  if (path === LIVENESS_PATH) {
    return false;
  }

  return method !== "OPTIONS";
}
