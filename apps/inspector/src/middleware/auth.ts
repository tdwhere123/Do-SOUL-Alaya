import { timingSafeEqual } from "node:crypto";
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

export function createInspectorAuthMiddleware(token: string, options: InspectorAuthOptions = {}): MiddlewareHandler {
  const expectedToken = normalizeToken(token);
  if (expectedToken === null) {
    throw new Error("inspector_token_missing");
  }
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

    const providedToken = readHeaderToken(context);
    if (providedToken === null || !constantTimeTokenEqual(providedToken, expectedToken)) {
      return context.json({ error: "unauthorized" }, 401);
    }

    await next();
  };
}

export function constantTimeTokenEqual(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  const maxLength = Math.max(providedBuffer.length, expectedBuffer.length, 1);
  const paddedProvided = Buffer.alloc(maxLength);
  const paddedExpected = Buffer.alloc(maxLength);
  providedBuffer.copy(paddedProvided);
  expectedBuffer.copy(paddedExpected);
  return timingSafeEqual(paddedProvided, paddedExpected) && providedBuffer.length === expectedBuffer.length;
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

function readHeaderToken(context: Context): string | null {
  const explicitHeader = normalizeToken(context.req.header("x-alaya-inspector-token"));
  if (explicitHeader !== null) {
    return explicitHeader;
  }

  const authorization = context.req.header("authorization") ?? "";
  const bearerPrefix = "Bearer ";
  return authorization.startsWith(bearerPrefix)
    ? normalizeToken(authorization.slice(bearerPrefix.length))
    : null;
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
