import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createInspectorAuthMiddleware } from "../middleware/auth.js";
import { registerInspectorBenchSummaryRoutes } from "../routes/bench-summary.js";
import { registerInspectorConfigRoutes } from "../routes/config.js";
import { registerInspectorGraphRoutes } from "../routes/graph.js";
import { registerInspectorHealthInboxRoutes } from "../routes/health-inbox.js";
import { registerInspectorMemoryEntryRoutes } from "../routes/memory-entries.js";
import { registerInspectorProposalRoutes } from "../routes/proposals.js";
import { registerInspectorRecallStatsRoutes } from "../routes/recall-stats.js";
import { registerInspectorSoulSearchRoutes } from "../routes/soul-search.js";
import { registerInspectorStatusRoutes } from "../routes/status.js";
import { registerInspectorStaticRoutes } from "../routes/static.js";

export const INSPECTOR_ROUTE_SURFACE = Object.freeze([
  "GET /api/config/:workspaceId/soul",
  "PATCH /api/config/:workspaceId/soul",
  "GET /api/config/:workspaceId/strategy",
  "PATCH /api/config/:workspaceId/strategy",
  "GET /api/config/:workspaceId/environment",
  "PATCH /api/config/:workspaceId/environment",
  "GET /api/config/:workspaceId/embedding-supplement",
  "PATCH /api/config/runtime/embedding-supplement",
  "GET /api/config/:workspaceId/garden-compute",
  "PATCH /api/config/runtime/garden-compute",
  "GET /api/config/:workspaceId/manifestation-budget",
  "PATCH /api/config/:workspaceId/manifestation-budget",
  "GET /api/bench-summary",
  "GET /api/bench-trend",
  "GET /api/embedding-status/:workspaceId",
  "GET /api/graph/:workspaceId",
  "GET /api/workspaces/:workspaceId/health-inbox",
  "GET /api/memory-entries/:workspaceId",
  "GET /api/pointers/:workspaceId/:objectId",
  "GET /api/recall-stats/:workspaceId",
  "GET /api/status",
  // Inspector loopback routes share the attached-agent proposal review
  // workflow for pending-proposals listing plus accept/reject.
  "GET /api/proposals/:workspaceId/pending",
  "POST /api/proposals/:workspaceId/:proposalId/review",
  "POST /api/proposals/:workspaceId/memory/:memoryId/keep",
  "POST /api/proposals/:workspaceId/memory/:memoryId/rewrite",
  "POST /api/proposals/:workspaceId/memory/:memoryId/downgrade",
  "POST /api/proposals/:workspaceId/memory/:memoryId/retire",
  "POST /api/workspaces/:workspaceId/soul/memory/:memoryId/proposals/promote-strictly-governed",
  "POST /api/soul/search/:workspaceId"
] as const);

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultStaticRoot = resolve(__dirname, "..", "..", "web", "dist");
export const MAX_INSPECTOR_REQUEST_BODY_BYTES = 10 * 1024 * 1024;
export const INSPECTOR_REQUEST_ID_HEADER = "x-request-id";
export const INSPECTOR_CORRELATION_ID_HEADER = "x-correlation-id";

export interface InspectorAppOptions {
  readonly token: string;
  readonly workspaceId?: string;
  readonly daemonUrl?: string;
  readonly staticRoot?: string;
  readonly benchHistoryRoot?: string;
  readonly fetchImpl?: typeof fetch;
  readonly env?: NodeJS.ProcessEnv;
  readonly clock?: () => string;
}

export function createInspectorApp(options: InspectorAppOptions): Hono {
  const app = new Hono();
  const env = options.env ?? process.env;
  const requestBodyLimit = bodyLimit({
    maxSize: MAX_INSPECTOR_REQUEST_BODY_BYTES,
    onError: (context) => context.json({ error: "request_body_too_large" }, 413)
  });
  app.use("*", async (context, next) => {
    const requestId = normalizeOptionalSecret(
      context.req.header(INSPECTOR_REQUEST_ID_HEADER) ??
        context.req.header(INSPECTOR_CORRELATION_ID_HEADER)
    ) ?? randomUUID();
    const requestScopedContext = context as typeof context & {
      set(name: string, value: string): void;
    };
    requestScopedContext.set("requestId", requestId);
    context.header(INSPECTOR_REQUEST_ID_HEADER, requestId);
    context.header(INSPECTOR_CORRELATION_ID_HEADER, requestId);
    await next();
  });
  app.onError((error, context) => {
    if (isRequestBodyTooLargeError(error)) {
      console.error("[inspector] sanitized route error", summarizeInspectorError(error, 413));
      return context.json({ error: "request_body_too_large" }, 413);
    }

    const status = isClientInputError(error) ? 400 : 500;
    console.error("[inspector] sanitized route error", summarizeInspectorError(error, status));
    return context.json({ error: status === 400 ? "invalid_request" : "internal_error" }, status);
  });
  app.use("*", createInspectorAuthMiddleware(options.token, { publicPathPrefixes: ["/assets/"] }));
  app.use("*", async (context, next) => {
    if (
      context.req.method !== "POST" &&
      context.req.method !== "PATCH" &&
      context.req.method !== "PUT" &&
      context.req.method !== "DELETE"
    ) {
      await next();
      return;
    }

    if (hasDeclaredOversizeBody(context.req.header("content-length"), MAX_INSPECTOR_REQUEST_BODY_BYTES)) {
      return context.json({ error: "request_body_too_large" }, 413);
    }

    await requestBodyLimit(context, next);
  });

  const proxyOptions = {
    daemonUrl: options.daemonUrl ?? "http://127.0.0.1:5173",
    workspaceId: normalizeOptionalSecret(options.workspaceId),
    fetchImpl: options.fetchImpl,
    daemonRequestToken: normalizeOptionalSecret(env.ALAYA_REQUEST_TOKEN),
    reviewerToken: normalizeOptionalSecret(env.ALAYA_REVIEWER_TOKEN),
    reviewerIdentity: normalizeOptionalSecret(env.ALAYA_REVIEWER_IDENTITY)
  };
  registerInspectorConfigRoutes(app, proxyOptions);
  registerInspectorGraphRoutes(app, proxyOptions);
  registerInspectorHealthInboxRoutes(app, proxyOptions);
  registerInspectorMemoryEntryRoutes(app, proxyOptions);
  registerInspectorStatusRoutes(app, proxyOptions);
  registerInspectorProposalRoutes(app, proxyOptions);
  registerInspectorRecallStatsRoutes(app, proxyOptions);
  registerInspectorSoulSearchRoutes(app, proxyOptions);
  registerInspectorBenchSummaryRoutes(app, {
    historyRoot:
      options.benchHistoryRoot ??
      resolve(process.cwd(), "docs/bench-history")
  });
  registerInspectorStaticRoutes(app, {
    staticRoot: options.staticRoot ?? defaultStaticRoot
  });
  return app;
}

function normalizeOptionalSecret(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function isClientInputError(error: unknown): boolean {
  return error instanceof SyntaxError || (error instanceof Error && error.name === "ZodError");
}

function summarizeInspectorError(
  error: unknown,
  status: number
): {
  readonly name: string;
  readonly status: number;
  readonly messageRedacted: true;
} {
  return {
    name: error instanceof Error ? error.name : "NonError",
    status,
    messageRedacted: true
  };
}

function isRequestBodyTooLargeError(error: unknown): boolean {
  return readStatusCode(error) === 413 || readErrorName(error) === "BodyLimitError";
}

function readStatusCode(error: unknown): number | null {
  if (error === null || typeof error !== "object") {
    return null;
  }

  const candidate = error as {
    readonly status?: unknown;
    readonly statusCode?: unknown;
    readonly cause?: unknown;
  };

  if (typeof candidate.status === "number") {
    return candidate.status;
  }

  if (typeof candidate.statusCode === "number") {
    return candidate.statusCode;
  }

  return candidate.cause === undefined ? null : readStatusCode(candidate.cause);
}

function readErrorName(error: unknown): string | null {
  if (error instanceof Error) {
    return error.name;
  }

  if (error === null || typeof error !== "object") {
    return null;
  }

  const candidate = error as { readonly cause?: unknown };
  return candidate.cause === undefined ? null : readErrorName(candidate.cause);
}

function hasDeclaredOversizeBody(contentLengthHeader: string | undefined, maxBytes: number): boolean {
  const declaredLength = contentLengthHeader === undefined
    ? Number.NaN
    : Number.parseInt(contentLengthHeader, 10);

  return Number.isFinite(declaredLength) && declaredLength > maxBytes;
}
