import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { isLoopbackInspectorClient } from "./launch-session-rate-limit.js";
import {
  INSPECTOR_SESSION_COOKIE,
  INSPECTOR_SESSION_TTL_MS,
  type InspectorLaunchSessionStore
} from "./launch-session-store.js";

export function createLoopbackAutoSessionMiddleware(input: {
  readonly launchCode: string | undefined;
  readonly launchSessionStore: InspectorLaunchSessionStore;
  readonly resolveClientAddress?: (context: Context) => string | undefined;
  readonly sessionTtlMs?: number;
}): MiddlewareHandler {
  const sessionMaxAgeSeconds = Math.max(
    1,
    Math.floor((input.sessionTtlMs ?? INSPECTOR_SESSION_TTL_MS) / 1000)
  );
  return async (context, next) => {
    await next();
    if (input.launchCode === undefined || !shouldMintLoopbackSession(context, input)) {
      return;
    }
    const sessionId = input.launchSessionStore.redeem(input.launchCode);
    if (sessionId === null) {
      return;
    }
    setCookie(context, INSPECTOR_SESSION_COOKIE, sessionId, {
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
      maxAge: sessionMaxAgeSeconds
    });
  };
}

function shouldMintLoopbackSession(
  context: Context,
  input: {
    readonly launchSessionStore: InspectorLaunchSessionStore;
    readonly resolveClientAddress?: (context: Context) => string | undefined;
  }
): boolean {
  if (context.req.method !== "GET" || context.res.status !== 200) {
    return false;
  }
  const path = context.req.path;
  if (path.startsWith("/api/") || path.startsWith("/assets/")) {
    return false;
  }
  const contentType = context.res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) {
    return false;
  }
  if (!isLoopbackInspectorClient(context, input.resolveClientAddress)) {
    return false;
  }
  const existing = getCookie(context, INSPECTOR_SESSION_COOKIE);
  return existing === undefined || !input.launchSessionStore.hasSession(existing);
}
