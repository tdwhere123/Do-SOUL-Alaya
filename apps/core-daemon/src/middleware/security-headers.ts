import type { Context, MiddlewareHandler } from "hono";

const CONTENT_SECURITY_POLICY =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

export function createApiSecurityHeadersMiddleware(): MiddlewareHandler {
  return async (context, next) => {
    await next();
    setHeaderIfAbsent(context, "content-security-policy", CONTENT_SECURITY_POLICY);
    setHeaderIfAbsent(context, "x-content-type-options", "nosniff");
    setHeaderIfAbsent(context, "x-frame-options", "DENY");
    setHeaderIfAbsent(context, "referrer-policy", "no-referrer");
    setHeaderIfAbsent(
      context,
      "permissions-policy",
      "accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), usb=()"
    );
    if (isSecureRequest(context)) {
      setHeaderIfAbsent(
        context,
        "strict-transport-security",
        "max-age=31536000; includeSubDomains"
      );
    }
  };
}

function setHeaderIfAbsent(context: Context, name: string, value: string): void {
  if (context.res.headers.has(name)) {
    return;
  }
  context.header(name, value);
}

function isSecureRequest(context: Context): boolean {
  const forwardedProto = normalizeHeader(context.req.header("x-forwarded-proto"));
  if (forwardedProto !== undefined) {
    return forwardedProto === "https";
  }

  try {
    return new URL(context.req.url).protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeHeader(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}
