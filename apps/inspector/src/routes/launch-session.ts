import type { Context, Hono } from "hono";
import type { InspectorLaunchSessionStore } from "../launch/launch-session-store.js";
import {
  createLaunchSessionFailureLimiter,
  resolveLaunchSessionClientKey,
  type LaunchSessionFailureLimiter,
  type LaunchSessionFailureLimiterOptions
} from "../launch/launch-session-rate-limit.js";

interface InspectorLaunchSessionRouteOptions extends LaunchSessionFailureLimiterOptions {
  readonly failureLimiter?: LaunchSessionFailureLimiter;
  readonly resolveClientKey?: (context: Context) => string;
}

export function registerInspectorLaunchSessionRoutes(
  app: Hono,
  launchSessionStore: InspectorLaunchSessionStore,
  options: InspectorLaunchSessionRouteOptions = {}
): void {
  const failureLimiter =
    options.failureLimiter ??
    createLaunchSessionFailureLimiter({
      maxConsecutiveFailures: options.maxConsecutiveFailures,
      windowMs: options.windowMs,
      nowMs: options.nowMs
    });
  const resolveClientKey = options.resolveClientKey ?? resolveLaunchSessionClientKey;

  app.post("/api/launch-session", async (context) => {
    const clientKey = resolveClientKey(context);
    if (failureLimiter.isLimited(clientKey)) {
      return context.json({ error: "rate_limited" }, 429);
    }

    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: "invalid_request" }, 400);
    }

    const code = readLaunchCode(body);
    if (code === null) {
      return context.json({ error: "invalid_request" }, 400);
    }

    const token = launchSessionStore.redeem(code);
    if (token === null) {
      failureLimiter.recordFailure(clientKey);
      if (failureLimiter.isLimited(clientKey)) {
        return context.json({ error: "rate_limited" }, 429);
      }
      return context.json({ error: "launch_code_invalid_or_expired" }, 401);
    }

    failureLimiter.reset(clientKey);
    return context.json({ token });
  });
}

function readLaunchCode(body: unknown): string | null {
  if (body === null || typeof body !== "object" || !("code" in body)) {
    return null;
  }
  const code = (body as { readonly code?: unknown }).code;
  if (typeof code !== "string") {
    return null;
  }
  const trimmed = code.trim();
  return trimmed.length === 0 ? null : trimmed;
}
