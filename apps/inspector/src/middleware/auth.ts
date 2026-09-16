import type { Context, MiddlewareHandler, Next } from "hono";
import { getCookie } from "hono/cookie";
import { INSPECTOR_SESSION_COOKIE } from "../launch/launch-session-store.js";

export interface InspectorPublicRoute {
  readonly path: string;
  readonly method: string;
}

export interface InspectorAuthOptions {
  readonly publicRoutes?: readonly InspectorPublicRoute[];
  readonly hasSession?: (sessionId: string) => boolean;
}

export function createInspectorAuthMiddleware(options: InspectorAuthOptions = {}): MiddlewareHandler {
  const publicRoutes = options.publicRoutes ?? [];
  const hasSession = options.hasSession;

  return async (context: Context, next: Next) => {
    if (isPublicRoute(context.req.path, context.req.method, publicRoutes)) {
      await next();
      return;
    }

    if (hasValidInspectorSession(context, hasSession)) {
      await next();
      return;
    }

    return context.json({ error: "unauthorized" }, 401);
  };
}

function hasValidInspectorSession(
  context: Context,
  hasSession: ((sessionId: string) => boolean) | undefined
): boolean {
  if (hasSession === undefined) {
    return false;
  }
  const sessionId = normalizeToken(getCookie(context, INSPECTOR_SESSION_COOKIE));
  return sessionId !== null && hasSession(sessionId);
}

function normalizeToken(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length === 0 ? null : trimmed;
}

function isPublicRoute(
  pathname: string,
  method: string,
  routes: readonly InspectorPublicRoute[]
): boolean {
  const normalizedMethod = method.toUpperCase();
  return routes.some((route) =>
    route.path === pathname && route.method.toUpperCase() === normalizedMethod
  );
}
