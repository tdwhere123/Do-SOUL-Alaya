import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { createInspectorAuthMiddleware } from "./auth.js";
import { registerInspectorBenchSummaryRoutes } from "./routes/bench-summary.js";
import { registerInspectorConfigRoutes } from "./routes/config.js";
import { registerInspectorGraphRoutes } from "./routes/graph.js";
import { registerInspectorProposalRoutes } from "./routes/proposals.js";
import { registerInspectorRecallStatsRoutes } from "./routes/recall-stats.js";
import { registerInspectorSoulSearchRoutes } from "./routes/soul-search.js";
import { registerInspectorStatusRoutes } from "./routes/status.js";
import { registerInspectorStaticRoutes } from "./static.js";

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
  "GET /api/bench-summary",
  "GET /api/embedding-status/:workspaceId",
  "GET /api/graph/:workspaceId",
  "GET /api/recall-stats/:workspaceId",
  "GET /api/status",
  // A1 (HITL daemon backbone) — Inspector loopback for the new
  // pending-proposals listing tool plus accept/reject.
  "GET /api/proposals/:workspaceId/pending",
  "POST /api/proposals/:workspaceId/:proposalId/review",
  "POST /api/proposals/:workspaceId/memory/:memoryId/keep",
  "POST /api/proposals/:workspaceId/memory/:memoryId/rewrite",
  "POST /api/proposals/:workspaceId/memory/:memoryId/downgrade",
  "POST /api/proposals/:workspaceId/memory/:memoryId/retire",
  "POST /api/soul/search/:workspaceId"
] as const);

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultStaticRoot = resolve(__dirname, "..", "web", "dist");

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
  app.onError((error, context) => {
    const status = isClientInputError(error) ? 400 : 500;
    console.error("[inspector] sanitized route error", summarizeInspectorError(error, status));
    return context.json({ error: status === 400 ? "invalid_request" : "internal_error" }, status);
  });
  app.use("*", createInspectorAuthMiddleware(options.token, { publicPathPrefixes: ["/assets/"] }));

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
  registerInspectorStatusRoutes(app, proxyOptions);
  registerInspectorProposalRoutes(app, proxyOptions);
  registerInspectorRecallStatsRoutes(app, proxyOptions);
  registerInspectorSoulSearchRoutes(app, proxyOptions);
  registerInspectorBenchSummaryRoutes(app, {
    historyRoot:
      options.benchHistoryRoot ??
      resolve(process.cwd(), "docs/v0.3/bench-history")
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
