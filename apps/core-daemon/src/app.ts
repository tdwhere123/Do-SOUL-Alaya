import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { registerErrorHandler } from "./middleware/error-handler.js";
import { registerBudgetRoutes, type BudgetRouteServices } from "./routes/budget.js";
import { registerClaimRoutes, type ClaimRouteServices } from "./routes/claims.js";
import { registerConfigRoutes, type ConfigRouteServices } from "./routes/config.js";
import {
  registerConflictMatrixRoutes,
  type ConflictMatrixRouteServices
} from "./routes/conflict-matrix.js";
import {
  registerE2eEventTriggerRoutes,
  type E2eEventTriggerRouteServices
} from "./routes/e2e-event-triggers.js";
import { registerEmbeddingStatusRoutes, type EmbeddingStatusRouteServices } from "./routes/embedding-status.js";
import { registerEvidenceRoutes, type EvidenceRouteServices } from "./routes/evidence.js";
import { registerFileRoutes, type FileRouteServices } from "./routes/files.js";
import { registerGardenBacklogRoutes } from "./routes/garden-backlog.js";
import { registerGlobalMemoryRoutes, type GlobalMemoryRouteServices } from "./routes/global-memory.js";
import { registerGovernanceRoutes, type GovernanceRouteServices } from "./routes/governance.js";
import { registerGreenStatusRoutes, type GreenStatusRouteServices } from "./routes/green-status.js";
import { registerHealthJournalRoutes, type HealthJournalRouteServices } from "./routes/health-journal.js";
import { registerMemoryRoutes, type MemoryRouteServices } from "./routes/memories.js";
import { registerOverrideRoutes, type OverrideRouteServices } from "./routes/overrides.js";
import {
  registerProjectMappingRoutes,
  type ProjectMappingRouteServices
} from "./routes/project-mapping.js";
import { registerProposalRoutes, type ProposalRouteServices } from "./routes/proposals.js";
import { registerRecallRoutes, type RecallRouteServices } from "./routes/recall.js";
import {
  registerRecallStatsRoutes,
  type RecallStatsRouteServices
} from "./routes/recall-stats.js";
import { registerRunRoutes, type RunRouteServices } from "./routes/runs.js";
import { registerSecurityStatusRoutes, type SecurityStatusRouteServices } from "./routes/security-status.js";
import { registerSignalRoutes, type SignalRouteServices } from "./routes/signals.js";
import { registerSlotRoutes, type SlotRouteServices } from "./routes/slots.js";
import { registerSoulGraphRoutes, type SoulGraphRouteServices } from "./routes/soul-graph.js";
import { registerSoulRoutes, type SoulRouteServices } from "./routes/soul.js";
import { registerSoulSearchRoutes, type SoulSearchRouteServices } from "./routes/soul-search.js";
import { registerStatusRoutes, type StatusRouteServices } from "./routes/status.js";
import { registerSynthesisRoutes, type SynthesisRouteServices } from "./routes/syntheses.js";
import { registerWorkspaceFileRoutes, type WorkspaceFilesRouteServices } from "./routes/workspace-files.js";
import { registerWorkspaceRoutes, type WorkspaceRouteServices } from "./routes/workspaces.js";

export const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;

export interface RequestProtectionConfig {
  readonly allowedOrigin: string;
  readonly requestToken: string;
  readonly allowDesktopOriginlessRequests?: boolean;
}

export interface CoreDaemonServices {
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
  readonly healthJournal?: HealthJournalRouteServices;
  readonly memories?: MemoryRouteServices;
  readonly overrides?: OverrideRouteServices;
  readonly projectMapping?: ProjectMappingRouteServices;
  readonly proposals?: ProposalRouteServices;
  readonly recall?: RecallRouteServices;
  readonly recallStats?: RecallStatsRouteServices;
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

  if (lifecycle !== undefined) {
    app.use("*", async (context, next) => {
      if (lifecycle.drainState.isDraining) {
        return context.json(
          { success: false, error: "daemon is draining" },
          503
        );
      }
      lifecycle.inFlight.count += 1;
      try {
        await next();
      } finally {
        lifecycle.inFlight.count -= 1;
      }
    });
  }

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
      allowHeaders: ["Content-Type", "X-Request-Token", "X-Alaya-Desktop"]
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
      const localOperatorRequest = isLocalOperatorRequest(context.req.header("x-alaya-desktop"));

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
      const localOperatorRequest = isLocalOperatorRequest(context.req.header("x-alaya-desktop"));

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
  registerConfiguredRoutes(app, services.routes);

  return app;
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
  if (routes.healthJournal !== undefined) registerHealthJournalRoutes(app, routes.healthJournal);
  if (routes.config !== undefined) registerConfigRoutes(app, routes.config);
  if (routes.overrides !== undefined) registerOverrideRoutes(app, routes.overrides);
  if (routes.governance !== undefined) registerGovernanceRoutes(app, routes.governance);
  if (routes.budget !== undefined) registerBudgetRoutes(app, routes.budget);
  if (routes.slots !== undefined) registerSlotRoutes(app, routes.slots);
  if (routes.recall !== undefined) registerRecallRoutes(app, routes.recall);
  if (routes.recallStats !== undefined)
    registerRecallStatsRoutes(app, routes.recallStats);
  if (routes.syntheses !== undefined) registerSynthesisRoutes(app, routes.syntheses);
  if (routes.claims !== undefined) registerClaimRoutes(app, routes.claims);
  if (routes.proposals !== undefined) registerProposalRoutes(app, routes.proposals);
  if (routes.files !== undefined) registerFileRoutes(app, routes.files);
  if (routes.soul !== undefined) registerSoulRoutes(app, routes.soul);
  if (routes.soulGraph !== undefined) registerSoulGraphRoutes(app, routes.soulGraph);
  if (routes.soulSearch !== undefined) registerSoulSearchRoutes(app, routes.soulSearch);
  if (routes.status !== undefined) registerStatusRoutes(app, routes.status);
  if (routes.projectMapping !== undefined) registerProjectMappingRoutes(app, routes.projectMapping);
  if (routes.globalMemory !== undefined) registerGlobalMemoryRoutes(app, routes.globalMemory);
  if (routes.conflictMatrix !== undefined) registerConflictMatrixRoutes(app, routes.conflictMatrix);
  if (routes.e2eEventTriggers !== undefined) registerE2eEventTriggerRoutes(app, routes.e2eEventTriggers);
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
