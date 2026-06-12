import { timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler, Next } from "hono";

export interface InspectorAuthOptions {
  readonly publicPathPrefixes?: readonly string[];
}

export function createInspectorAuthMiddleware(token: string, options: InspectorAuthOptions = {}): MiddlewareHandler {
  const expectedToken = normalizeToken(token);
  if (expectedToken === null) {
    throw new Error("inspector_token_missing");
  }
  const publicPathPrefixes = options.publicPathPrefixes ?? [];

  return async (context: Context, next: Next) => {
    if (isPublicPath(context.req.path, publicPathPrefixes)) {
      await next();
      return;
    }

    const providedToken = normalizeToken(
      context.req.query("token") ?? context.req.header("x-alaya-inspector-token")
    );
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

function normalizeToken(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length === 0 ? null : trimmed;
}

function isPublicPath(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => pathname.startsWith(prefix));
}
