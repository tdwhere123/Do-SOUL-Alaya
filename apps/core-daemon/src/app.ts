import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { registerErrorHandler } from "./middleware/error-handler.js";

export const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;

export interface RequestProtectionConfig {
  readonly allowedOrigin: string;
  readonly requestToken: string;
  readonly allowDesktopOriginlessRequests?: boolean;
}

export interface CoreDaemonServices {
  readonly requestProtection?: RequestProtectionConfig;
}

export function createApp(services: CoreDaemonServices = {}): Hono {
  const app = new Hono();
  const allowedOrigin =
    services.requestProtection?.allowedOrigin ?? process.env.ALLOWED_ORIGIN ?? "http://localhost:5173";
  const allowDesktopOriginlessRequests =
    services.requestProtection?.allowDesktopOriginlessRequests ?? true;
  const fileUploadBodyLimit = bodyLimit({
    maxSize: MAX_FILE_SIZE_BYTES,
    onError: (context) =>
      context.json(
        {
          success: false,
          error: "File exceeds the 20 MB limit"
        },
        413
      )
  });

  app.use(
    "*",
    cors({
      origin: (origin) => {
        const normalizedOrigin = normalizeOrigin(origin);

        if (normalizedOrigin === allowedOrigin) {
          return allowedOrigin;
        }

        return "";
      },
      allowHeaders: ["Content-Type", "X-Request-Token", "X-Do-What-Desktop"]
    })
  );

  if (services.requestProtection !== undefined) {
    const { requestToken } = services.requestProtection;

    app.use("*", async (context, next) => {
      if (!isProtectedRequest(context.req.method, context.req.path, context.req.query("run_id"))) {
        await next();
        return;
      }

      const origin = normalizeOrigin(context.req.header("origin"));
      const localOperatorRequest = isLocalOperatorRequest(context.req.header("x-do-what-desktop"));

      if (!isAllowedMutatingOrigin(origin, allowedOrigin, localOperatorRequest, allowDesktopOriginlessRequests)) {
        return context.json(
          {
            success: false,
            error: "Origin is not allowed"
          },
          403
        );
      }

      const providedRequestToken = context.req.header("x-request-token")?.trim();

      if (providedRequestToken === undefined || providedRequestToken.length === 0) {
        return context.json(
          {
            success: false,
            error: "X-Request-Token is required"
          },
          403
        );
      }

      if (!matchesRequestToken(providedRequestToken, requestToken)) {
        return context.json(
          {
            success: false,
            error: "Invalid X-Request-Token"
          },
          403
        );
      }

      await next();
    });

    app.get("/session/request-token", (context) => {
      const origin = normalizeOrigin(context.req.header("origin"));
      const localOperatorRequest = isLocalOperatorRequest(context.req.header("x-do-what-desktop"));

      if (!isAllowedRequestTokenOrigin(origin, allowedOrigin, localOperatorRequest, allowDesktopOriginlessRequests)) {
        return context.json(
          {
            success: false,
            error: "Origin is not allowed"
          },
          403
        );
      }

      return context.json(
        {
          success: true,
          data: {
            request_token: requestToken
          }
        },
        200
      );
    });
  }

  app.use("/files", async (context, next) => {
    if (context.req.method !== "POST") {
      await next();
      return;
    }

    await fileUploadBodyLimit(context, next);
  });

  registerErrorHandler(app);

  return app;
}

function isProtectedRequest(method: string, path: string, runIdQuery: string | undefined): boolean {
  return (
    isMutatingMethod(method) ||
    isAuditProtectedGet(method, path) ||
    isSlashDiscoveryProtectedGet(method, path, runIdQuery)
  );
}

function isMutatingMethod(method: string): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

function isAuditProtectedGet(method: string, path: string): boolean {
  if (method !== "GET") {
    return false;
  }

  return (
    /^\/soul\/workspaces\/[^/]+\/topology$/.test(path) ||
    /^\/runs\/[^/]+\/recall-candidates$/.test(path)
  );
}

function isSlashDiscoveryProtectedGet(method: string, path: string, runIdQuery: string | undefined): boolean {
  return method === "GET" && path === "/slash-commands" && runIdQuery !== undefined && runIdQuery.trim().length > 0;
}

function normalizeOrigin(origin: string | undefined): string | undefined {
  const normalized = origin?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function isLocalOperatorRequest(header: string | undefined): boolean {
  return header?.trim() === "1";
}

function isAllowedProtectedRequest(
  origin: string | undefined,
  allowedOrigin: string,
  localOperatorRequest: boolean,
  allowDesktopOriginlessRequests: boolean
): boolean {
  if (origin === allowedOrigin) {
    return true;
  }

  if (!allowDesktopOriginlessRequests) {
    return false;
  }

  return origin === undefined && localOperatorRequest;
}

function isAllowedMutatingOrigin(
  origin: string | undefined,
  allowedOrigin: string,
  localOperatorRequest: boolean,
  allowDesktopOriginlessRequests: boolean
): boolean {
  return isAllowedProtectedRequest(origin, allowedOrigin, localOperatorRequest, allowDesktopOriginlessRequests);
}

function isAllowedRequestTokenOrigin(
  origin: string | undefined,
  allowedOrigin: string,
  localOperatorRequest: boolean,
  allowDesktopOriginlessRequests: boolean
): boolean {
  return isAllowedProtectedRequest(origin, allowedOrigin, localOperatorRequest, allowDesktopOriginlessRequests);
}

function matchesRequestToken(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);

  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(providedBuffer, expectedBuffer);
}
