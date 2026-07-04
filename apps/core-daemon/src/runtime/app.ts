import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { constantTimeTokenEqual } from "../shared/constant-time-token.js";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { readBuildInfo } from "./build-info.js";
import { createWarnLogger } from "./daemon-runtime-helpers.js";
import { registerErrorHandler, type ErrorLoggerPort } from "../middleware/error-handler.js";
import { registerBudgetRoutes, type BudgetRouteServices } from "../routes/governance/budget.js";
import { registerClaimRoutes, type ClaimRouteServices } from "../routes/governance/claims.js";
import { registerConfigRoutes, type ConfigRouteServices } from "../routes/workspace/config.js";
import {
  registerConflictMatrixRoutes,
  type ConflictMatrixRouteServices
} from "../routes/governance/conflict-matrix.js";
import {
  registerE2eEventTriggerRoutes,
  type E2eEventTriggerRouteServices
} from "../routes/workspace/e2e-event-triggers.js";
import { registerEmbeddingStatusRoutes, type EmbeddingStatusRouteServices } from "../routes/workspace/embedding-status.js";
import { registerEvidenceRoutes, type EvidenceRouteServices } from "../routes/memory/evidence.js";
import { registerFileRoutes, type FileRouteServices } from "../routes/workspace/files.js";
import { registerGardenBacklogRoutes } from "../routes/garden/garden-backlog.js";
import { registerGlobalMemoryRoutes, type GlobalMemoryRouteServices } from "../routes/memory/global-memory.js";
import { registerGovernanceRoutes, type GovernanceRouteServices } from "../routes/governance/governance.js";
import { registerGreenStatusRoutes, type GreenStatusRouteServices } from "../routes/garden/green-status.js";
import {
  registerHealthInboxRoutes,
  type HealthInboxRouteServices
} from "../routes/garden/health-inbox.js";
import { registerHealthJournalRoutes, type HealthJournalRouteServices } from "../routes/garden/health-journal.js";
import { registerMemoryRoutes, type MemoryRouteServices } from "../routes/memory/memories.js";
import { registerOverrideRoutes, type OverrideRouteServices } from "../routes/governance/overrides.js";
import {
  registerProjectMappingRoutes,
  type ProjectMappingRouteServices
} from "../routes/workspace/project-mapping.js";
import { registerProposalRoutes, type ProposalRouteServices } from "../routes/governance/proposals.js";
import { registerRecallRoutes, type RecallRouteServices } from "../routes/memory/recall.js";
import {
  registerRecallStatsRoutes,
  type RecallStatsRouteServices
} from "../routes/memory/recall-stats.js";
import {
  registerRecallUtilizationRoutes,
  type RecallUtilizationRouteServices
} from "../routes/memory/recall-utilization.js";
import { registerRunRoutes, type RunRouteServices } from "../routes/workspace/runs.js";
import { registerSecurityStatusRoutes, type SecurityStatusRouteServices } from "../routes/workspace/security-status.js";
import { registerSignalRoutes, type SignalRouteServices } from "../routes/workspace/signals.js";
import { registerSlotRoutes, type SlotRouteServices } from "../routes/governance/slots.js";
import { registerPathGraphRoutes, type PathGraphRouteServices } from "../routes/workspace/path-graph.js";
import { registerSoulGraphRoutes, type SoulGraphRouteServices } from "../routes/memory/soul-graph.js";
import { registerSoulRoutes, type SoulRouteServices } from "../routes/memory/soul.js";
import { registerSoulSearchRoutes, type SoulSearchRouteServices } from "../routes/memory/soul-search.js";
import { registerStatusRoutes, type StatusRouteServices } from "../routes/workspace/status.js";
import { registerSynthesisRoutes, type SynthesisRouteServices } from "../routes/memory/syntheses.js";
import { registerWorkspaceFileRoutes, type WorkspaceFilesRouteServices } from "../routes/workspace/workspace-files.js";
import { registerWorkspaceRoutes, type WorkspaceRouteServices } from "../routes/workspace/workspaces.js";

export const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;
export const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;
export const REQUEST_ID_HEADER = "x-request-id";
export const CORRELATION_ID_HEADER = "x-correlation-id";

export interface RequestProtectionConfig {
  readonly allowedOrigin: string;
  readonly requestToken: string;
  readonly allowDesktopOriginlessRequests?: boolean;
  readonly tokenSource?: "env" | "ephemeral";
}

export interface CoreDaemonServices {
  readonly logger?: ErrorLoggerPort;
  readonly requestProtection?: RequestProtectionConfig;
  readonly routes?: CoreDaemonRouteServices;
}

export interface CoreDaemonRouteServices {
  readonly budget?: BudgetRouteServices;
  readonly claims?: ClaimRouteServices;
  readonly config?: ConfigRouteServices;
  readonly conflictMatrix?: ConflictMatrixRouteServices;
  readonly e2eEventTriggers?: E2eEventTriggerRouteServices;
  readonly embeddingStatus?: EmbeddingStatusRouteServices;
  readonly evidence?: EvidenceRouteServices;
  readonly files?: FileRouteServices;
  readonly gardenBacklog?: Parameters<typeof registerGardenBacklogRoutes>[1];
  readonly globalMemory?: GlobalMemoryRouteServices;
  readonly governance?: GovernanceRouteServices;
  readonly greenStatus?: GreenStatusRouteServices;
  readonly healthInbox?: HealthInboxRouteServices;
  readonly healthJournal?: HealthJournalRouteServices;
  readonly memories?: MemoryRouteServices;
  readonly overrides?: OverrideRouteServices;
  readonly pathGraph?: PathGraphRouteServices;
  readonly projectMapping?: ProjectMappingRouteServices;
  readonly proposals?: ProposalRouteServices;
  readonly recall?: RecallRouteServices;
  readonly recallStats?: RecallStatsRouteServices;
  readonly recallUtilization?: RecallUtilizationRouteServices;
  readonly runs?: RunRouteServices;
  readonly securityStatus?: SecurityStatusRouteServices;
  readonly signals?: SignalRouteServices;
  readonly slots?: SlotRouteServices;
  readonly soul?: SoulRouteServices;
  readonly soulGraph?: SoulGraphRouteServices;
  readonly soulSearch?: SoulSearchRouteServices;
  readonly status?: StatusRouteServices;
  readonly syntheses?: SynthesisRouteServices;
  readonly workspaceFiles?: WorkspaceFilesRouteServices;
  readonly workspaces?: WorkspaceRouteServices;
}

/**
 * Shared mutable lifecycle state injected by index.ts so that shutdown
 * can stop accepting new requests while waiting for in-flight handlers
 * to finish.
 *
 * `isDraining` flips to true when SIGTERM/SIGINT arrives; the drain
 * middleware returns 503 for any new request so a process-orchestrator
 * cannot wedge an EventLog mid-write during shutdown.
 *
 * `inFlight.count` is incremented at request start and decremented in
 * a finally block; shutdown awaits it reaching zero (with a timeout).
 */
export interface CoreDaemonLifecycleState {
  readonly drainState: { isDraining: boolean };
  readonly inFlight: { count: number };
}

export function createApp(
  services: CoreDaemonServices = {},
  lifecycle?: CoreDaemonLifecycleState
): Hono {
  const app = new Hono();
  const requestProtection = resolveRequestProtectionSettings(services.requestProtection);
  const bodyLimits = createRequestBodyLimits();

  registerRequestIdMiddleware(app);
  registerDrainMiddleware(app, lifecycle);
  registerCorsMiddleware(app, requestProtection.allowedOrigin);
  registerProtectedRequestMiddleware(app, services.requestProtection, requestProtection);
  registerFileUploadLimitMiddleware(app, bodyLimits.fileUploadBodyLimit);
  registerRequestBodyLimitMiddleware(app, bodyLimits.requestBodyLimit);

  registerErrorHandler(app, services.logger ?? createWarnLogger());
  registerLivenessRoute(app);
  registerConfiguredRoutes(app, services.routes);

  return app;
}

// Standard unauthenticated liveness probe for deployment health checks.
// Only the liveness path is exempt from the request-token gate, and the drain
// middleware skips LIVENESS_PATH, so this stays cheap and never touches the DB
// or any provider — liveness means "process is up".
const LIVENESS_PATH = "/health";

type ResolvedRequestProtectionSettings = Readonly<{
  allowedOrigin: string;
  allowDesktopOriginlessRequests: boolean;
}>;

function registerRequestIdMiddleware(app: Hono): void {
  app.use("*", async (context, next) => {
    const requestId = resolveRequestId(
      context.req.header(REQUEST_ID_HEADER),
      context.req.header(CORRELATION_ID_HEADER)
    );
    const requestScopedContext = context as typeof context & {
      set(name: string, value: string): void;
    };
    requestScopedContext.set("requestId", requestId);
    requestScopedContext.set("correlationId", requestId);
    context.header(REQUEST_ID_HEADER, requestId);
    context.header(CORRELATION_ID_HEADER, requestId);
    await next();
  });
}

function registerDrainMiddleware(
  app: Hono,
  lifecycle: CoreDaemonLifecycleState | undefined
): void {
  if (lifecycle === undefined) {
    return;
  }

  app.use("*", async (context, next) => {
    if (context.req.path === LIVENESS_PATH) {
      await next();
      return;
    }
    if (lifecycle.drainState.isDraining) {
      return context.json({ success: false, error: "daemon is draining" }, 503);
    }
    lifecycle.inFlight.count += 1;
    try {
      await next();
    } finally {
      lifecycle.inFlight.count -= 1;
    }
  });
}

function resolveRequestProtectionSettings(
  requestProtection: RequestProtectionConfig | undefined
): ResolvedRequestProtectionSettings {
  return {
    allowedOrigin:
      requestProtection?.allowedOrigin ??
      process.env.ALLOWED_ORIGIN ??
      "http://localhost:5173",
    allowDesktopOriginlessRequests:
      requestProtection?.allowDesktopOriginlessRequests ?? true
  };
}

function createRequestBodyLimits() {
  return {
    fileUploadBodyLimit: bodyLimit({
      maxSize: MAX_FILE_SIZE_BYTES,
      onError: (context) =>
        context.json({ success: false, error: "File exceeds the 20 MB limit" }, 413)
    }),
    requestBodyLimit: bodyLimit({
      maxSize: MAX_REQUEST_BODY_BYTES,
      onError: (context) =>
        context.json({ success: false, error: "Request body exceeds the 10 MB limit" }, 413)
    })
  };
}

function registerCorsMiddleware(app: Hono, allowedOrigin: string): void {
  app.use(
    "*",
    cors({
      origin: (origin) => resolveCorsOrigin(origin, allowedOrigin),
      allowHeaders: [
        "Content-Type",
        "X-Request-Token",
        "X-Alaya-Desktop",
        "X-Request-Id",
        "X-Correlation-Id"
      ],
      exposeHeaders: [
        "X-Request-Id",
        "X-Correlation-Id",
        "X-Total-Count",
        "X-Limit",
        "X-Offset"
      ]
    })
  );
}

function resolveCorsOrigin(origin: string | undefined, allowedOrigin: string): string {
  return normalizeOrigin(origin) === allowedOrigin ? allowedOrigin : "";
}

function registerProtectedRequestMiddleware(
  app: Hono,
  requestProtection: RequestProtectionConfig | undefined,
  settings: ResolvedRequestProtectionSettings
): void {
  app.use("*", async (context, next) => {
    if (!isProtectedRequest(context.req.method, context.req.path)) {
      await next();
      return;
    }

    if (requestProtection === undefined) {
      return context.json(
        { success: false, error: "Request protection is not configured" },
        503
      );
    }

    const origin = normalizeOrigin(context.req.header("origin"));
    const localOperatorRequest = isLocalOperatorRequest(
      context.req.header("x-alaya-desktop")
    );

    if (
      !isAllowedProtectedRequest(
        origin,
        settings.allowedOrigin,
        localOperatorRequest,
        settings.allowDesktopOriginlessRequests
      )
    ) {
      return context.json({ success: false, error: "Origin is not allowed" }, 403);
    }

    const tokenError = validateRequestTokenHeader(
      context.req.header("x-request-token"),
      requestProtection.requestToken
    );
    if (tokenError !== null) {
      return context.json({ success: false, error: tokenError }, 403);
    }

    await next();
  });
}

function validateRequestTokenHeader(
  providedRequestTokenHeader: string | undefined,
  expectedRequestToken: string
): string | null {
  const providedRequestToken = providedRequestTokenHeader?.trim();
  if (providedRequestToken === undefined || providedRequestToken.length === 0) {
    return "X-Request-Token is required";
  }
  return matchesRequestToken(providedRequestToken, expectedRequestToken)
    ? null
    : "Invalid X-Request-Token";
}

function registerFileUploadLimitMiddleware(
  app: Hono,
  fileUploadBodyLimit: ReturnType<typeof bodyLimit>
): void {
  app.use("/files", async (context, next) => {
    if (context.req.method !== "POST") {
      await next();
      return;
    }
    if (hasDeclaredOversizeBody(context.req.header("content-length"), MAX_FILE_SIZE_BYTES)) {
      return context.json({ success: false, error: "File exceeds the 20 MB limit" }, 413);
    }
    await fileUploadBodyLimit(context, next);
  });
}

function registerRequestBodyLimitMiddleware(
  app: Hono,
  requestBodyLimit: ReturnType<typeof bodyLimit>
): void {
  app.use("*", async (context, next) => {
    if (!isBodyLimitedMethod(context.req.method) || context.req.path === "/files") {
      await next();
      return;
    }
    if (hasDeclaredOversizeBody(context.req.header("content-length"), MAX_REQUEST_BODY_BYTES)) {
      return context.json(
        { success: false, error: "Request body exceeds the 10 MB limit" },
        413
      );
    }
    await requestBodyLimit(context, next);
  });
}

function registerLivenessRoute(app: Hono): void {
  const { version } = readBuildInfo();
  app.get(LIVENESS_PATH, (context) =>
    context.json({ status: "ok", service: "alaya-core-daemon", version, uptime_s: process.uptime() }, 200)
  );
}

function registerConfiguredRoutes(app: Hono, routes: CoreDaemonRouteServices | undefined): void {
  if (routes === undefined) {
    return;
  }

  if (routes.workspaces !== undefined) registerWorkspaceRoutes(app, routes.workspaces);
  if (routes.workspaceFiles !== undefined) registerWorkspaceFileRoutes(app, routes.workspaceFiles);
  if (routes.securityStatus !== undefined) registerSecurityStatusRoutes(app, routes.securityStatus);
  if (routes.embeddingStatus !== undefined) registerEmbeddingStatusRoutes(app, routes.embeddingStatus);
  if (routes.runs !== undefined) registerRunRoutes(app, routes.runs);
  if (routes.signals !== undefined) registerSignalRoutes(app, routes.signals);
  if (routes.evidence !== undefined) registerEvidenceRoutes(app, routes.evidence);
  if (routes.gardenBacklog !== undefined) registerGardenBacklogRoutes(app, routes.gardenBacklog);
  if (routes.memories !== undefined) registerMemoryRoutes(app, routes.memories);
  if (routes.greenStatus !== undefined) registerGreenStatusRoutes(app, routes.greenStatus);
  if (routes.healthInbox !== undefined) registerHealthInboxRoutes(app, routes.healthInbox);
  if (routes.healthJournal !== undefined) registerHealthJournalRoutes(app, routes.healthJournal);
  if (routes.config !== undefined) registerConfigRoutes(app, routes.config);
  if (routes.overrides !== undefined) registerOverrideRoutes(app, routes.overrides);
  if (routes.governance !== undefined) registerGovernanceRoutes(app, routes.governance);
  if (routes.budget !== undefined) registerBudgetRoutes(app, routes.budget);
  if (routes.slots !== undefined) registerSlotRoutes(app, routes.slots);
  if (routes.recall !== undefined) registerRecallRoutes(app, routes.recall);
  if (routes.recallStats !== undefined)
    registerRecallStatsRoutes(app, routes.recallStats);
  if (routes.recallUtilization !== undefined)
    registerRecallUtilizationRoutes(app, routes.recallUtilization);
  if (routes.syntheses !== undefined) registerSynthesisRoutes(app, routes.syntheses);
  if (routes.claims !== undefined) registerClaimRoutes(app, routes.claims);
  if (routes.proposals !== undefined) registerProposalRoutes(app, routes.proposals);
  if (routes.files !== undefined) registerFileRoutes(app, routes.files);
  if (routes.soul !== undefined) registerSoulRoutes(app, routes.soul);
  if (routes.soulGraph !== undefined) registerSoulGraphRoutes(app, routes.soulGraph);
  if (routes.pathGraph !== undefined) registerPathGraphRoutes(app, routes.pathGraph);
  if (routes.soulSearch !== undefined) registerSoulSearchRoutes(app, routes.soulSearch);
  if (routes.status !== undefined) registerStatusRoutes(app, routes.status);
  if (routes.projectMapping !== undefined) registerProjectMappingRoutes(app, routes.projectMapping);
  if (routes.globalMemory !== undefined) registerGlobalMemoryRoutes(app, routes.globalMemory);
  if (routes.conflictMatrix !== undefined) registerConflictMatrixRoutes(app, routes.conflictMatrix);
  if (routes.e2eEventTriggers !== undefined) registerE2eEventTriggerRoutes(app, routes.e2eEventTriggers);
}

function isProtectedRequest(method: string, path: string): boolean {
  if (path === LIVENESS_PATH) {
    return false;
  }

  return method !== "OPTIONS";
}

function normalizeOrigin(origin: string | undefined): string | undefined {
  const normalized = origin?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function resolveRequestId(
  requestIdHeader: string | undefined,
  correlationIdHeader: string | undefined
): string {
  const requestId = normalizeOrigin(requestIdHeader);
  if (requestId !== undefined) {
    return requestId;
  }

  const correlationId = normalizeOrigin(correlationIdHeader);
  return correlationId ?? randomUUID();
}

function isBodyLimitedMethod(method: string): boolean {
  return method === "POST" || method === "PATCH" || method === "PUT" || method === "DELETE";
}

function hasDeclaredOversizeBody(contentLengthHeader: string | undefined, maxBytes: number): boolean {
  const declaredLength = contentLengthHeader === undefined
    ? Number.NaN
    : Number.parseInt(contentLengthHeader, 10);

  return Number.isFinite(declaredLength) && declaredLength > maxBytes;
}

function isLocalOperatorRequest(header: string | undefined): boolean {
  return header?.trim() === "1";
}

// The origin gate only defends against browser CSRF; the X-Request-Token is the
// sole real authentication. allowDesktopOriginlessRequests admits origin-less
// desktop calls and should be disabled when ALAYA_ALLOW_REMOTE_DAEMON=1.
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

function matchesRequestToken(provided: string, expected: string): boolean {
  return constantTimeTokenEqual(provided, expected);
}
