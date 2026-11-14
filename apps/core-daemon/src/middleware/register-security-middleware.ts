import type { Hono } from "hono";
import { processEnvLookup } from "../runtime/config/daemon-config-environment.js";
import { isRemoteDaemonBind } from "../runtime/server-options.js";
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
  readonly failClosedOnUnknownSocket?: boolean;
}

export function registerSecurityHeadersMiddleware(app: Hono): void {
  app.use("*", createApiSecurityHeadersMiddleware());
}

export function resolveRateLimitSettings(
  config: CoreDaemonRateLimitConfig | undefined
): Required<Pick<CoreDaemonRateLimitConfig, "maxRequests" | "windowMs" | "failClosedOnUnknownSocket">> &
  Pick<CoreDaemonRateLimitConfig, "nowMs"> {
  return {
    maxRequests: config?.maxRequests ?? DEFAULT_RATE_LIMIT_MAX_REQUESTS,
    windowMs: config?.windowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS,
    failClosedOnUnknownSocket: config?.failClosedOnUnknownSocket ?? isRemoteDaemonBind(processEnvLookup()),
    ...(config?.nowMs === undefined ? {} : { nowMs: config.nowMs })
  };
}

export function registerRateLimitMiddleware(
  app: Hono,
  config: CoreDaemonRateLimitConfig | undefined
): void {
  const settings = resolveRateLimitSettings(config);
  // Successful protected requests keep a token+peer quota; failed auth is
  // counted separately by peer identity in the token gate.
  app.use(
    "*",
    createFixedWindowRateLimitMiddleware({
      maxRequests: settings.maxRequests,
      windowMs: settings.windowMs,
      ...(settings.nowMs === undefined ? {} : { nowMs: settings.nowMs }),
      skip: (context) => !isProtectedRequest(context.req.method, context.req.path),
      failClosedOnUnknownSocket: settings.failClosedOnUnknownSocket,
      resolveKey: (context) =>
        resolveProtectedRateLimitKey(context, settings.failClosedOnUnknownSocket)
    })
  );
}

export function isProtectedRequest(method: string, path: string): boolean {
  if (path === LIVENESS_PATH) {
    return false;
  }

  return method !== "OPTIONS";
}
