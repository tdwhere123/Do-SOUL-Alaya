import type { Context, Hono } from "hono";
import { CoreError, type ConversationService, type RunHotStateService, type RunService } from "@do-soul/alaya-core";
import {
  parseJsonBody,
  parseListPagination,
  rejectUnexpectedRequestBody,
  writeListPaginationHeaders
} from "./shared.js";
import {
  type EventLogEntry,
  RunInterruptResultSchema,
  RunRenameInputSchema,
} from "@do-soul/alaya-protocol";
import {
  deleteRunSnapshotCache,
  enrichRunSnapshot,
  type SnapshotCursorState
} from "./run-snapshot.js";
import { SnapshotCompactionError } from "./run-snapshot-compaction.js";

export { resetSnapshotCacheForTesting } from "./run-snapshot.js";

export interface RunRouteServices {
  readonly runService: RunService;
  readonly conversationService: ConversationService;
  readonly runHotStateService: RunHotStateService;
  readonly eventLogRepo?: {
    queryByRun(runId: string): Promise<readonly EventLogEntry[]>;
    queryByRunAll(runId: string): Promise<readonly EventLogEntry[]>;
    /**
     * Returns events for the run with rowid strictly after the row whose
     * event_id equals lastEventId. When lastEventId does not exist in the DB
     * (e.g. it was deleted by a rollback), the storage layer falls back to
     * rowid > 0 and returns ALL events for the run. Callers must treat a
     * non-empty result as potentially ambiguous (cursor-loss vs genuine delta)
     * and use the queryByRun + filterEventsAfter path for safety in that case.
     *
     * Optional: when absent the cache-hit path skips the M1 fast-path probe
     * and falls through to the full queryByRun fetch.
     */
    queryByRunAfterEventId?(runId: string, lastEventId: string): Promise<readonly EventLogEntry[]>;
    queryByRunCursorState?(
      runId: string,
      lastEventId: string | null
    ): Promise<SnapshotCursorState>;
    //
    // Note: an empty result is also returned when the cursor event itself was
    // deleted AND no events have been appended since. C-28 pairs the fast-path
    // probe with queryByRunCursorState so the route can detect that drift and
    // rebuild from current event history instead of relying on TTL expiry.
  };
  readonly governanceLeaseService?: {
    release(runId: string): Promise<void>;
  };
  readonly sessionOverrideService?: {
    clearRun(runId: string): void;
  };
  readonly budgetBankruptcyService?: {
    clearRun(runId: string): void;
  };
  readonly contextLensAssembler?: {
    clearLens(runId: string): void;
  };
  readonly warn?: (message: string, meta: Record<string, unknown>) => void;
}

export function registerRunRoutes(app: Hono, services: RunRouteServices): void {
  registerRunCollectionRoutes(app, services);
  registerRunMessageRoutes(app, services);
  registerRunLifecycleRoutes(app, services);
}

function registerRunCollectionRoutes(app: Hono, services: RunRouteServices): void {
  app.post("/workspaces/:id/runs", async (context) => {
    const run = await services.runService.create(
      context.req.param("id"),
      await parseJsonBody(context.req.json.bind(context.req))
    );

    return context.json({ success: true, data: run }, 201);
  });

  app.get("/workspaces/:id/runs", async (context) => {
    const workspaceId = context.req.param("id");
    const pagination = parseListPagination(context);
    const runs = await services.runService.listByWorkspace(workspaceId, pagination);
    const totalCount = await services.runService.countByWorkspace(workspaceId);
    writeListPaginationHeaders(context, totalCount, pagination);
    return context.json({ success: true, data: runs }, 200);
  });

  app.get("/runs/:id", async (context) => {
    const run = await services.runService.getById(context.req.param("id"));
    return context.json({ success: true, data: run }, 200);
  });
}

function registerRunMessageRoutes(app: Hono, services: RunRouteServices): void {
  app.get("/runs/:id/messages", async (context) => {
    const runId = context.req.param("id");
    const pagination = parseListPagination(context);
    const messages = await services.conversationService.listMessages(runId, pagination);
    const totalCount = await services.conversationService.countMessages(runId);
    writeListPaginationHeaders(context, totalCount, pagination);
    return context.json({ success: true, data: messages }, 200);
  });

  app.post("/runs/:id/messages", async (context) => {
    const response = await services.conversationService.sendMessage(
      context.req.param("id"),
      await parseJsonBody(context.req.json.bind(context.req))
    );

    return context.json({ success: true, data: response }, 200);
  });

  app.post("/runs/:id/messages/stream", async (context) => {
    const response = await services.conversationService.sendMessageStreaming(
      context.req.param("id"),
      await parseJsonBody(context.req.json.bind(context.req))
    );

    return context.json({ success: true, data: response }, 200);
  });
}

function registerRunLifecycleRoutes(app: Hono, services: RunRouteServices): void {
  app.post("/runs/:id/interrupt", async (context) => {
    const unexpectedBody = await rejectUnexpectedRequestBody(context);
    if (unexpectedBody !== null) return unexpectedBody;
    const runId = context.req.param("id");
    const result = await services.conversationService.interruptRun(runId);

    return context.json({ success: true, data: RunInterruptResultSchema.parse(result) }, 200);
  });

  app.get("/runs/:id/snapshot", async (context) => {
    return await getRunSnapshot(context, services);
  });

  app.patch("/runs/:id", async (context) => {
    const runId = context.req.param("id");
    const body = parseRunRenameInput(runId, await parseJsonBody(context.req.json.bind(context.req)));
    const run = await services.runService.rename(body);
    return context.json({ success: true, data: run }, 200);
  });

  app.delete("/runs/:id", async (context) => {
    return await deleteRun(context, services);
  });
}

async function getRunSnapshot(context: Context, services: RunRouteServices): Promise<Response> {
  const runId = context.req.param("id")!;
  await services.runService.getById(runId);
  const snapshot = await services.runHotStateService.getSnapshot(runId);
  if (snapshot === null) throw new CoreError("NOT_FOUND", "Run not found");
  try {
    return context.json(
      { success: true, data: await enrichRunSnapshot(snapshot, runId, services.eventLogRepo, services.warn) },
      200
    );
  } catch (error) {
    if (error instanceof SnapshotCompactionError) return snapshotCompactionFailure(context, services, runId, error);
    throw error;
  }
}

function snapshotCompactionFailure(
  context: Context,
  services: RunRouteServices,
  runId: string,
  error: SnapshotCompactionError
): Response {
  logRunRouteWarning(services.warn, "[daemon] snapshot compaction failed", {
    runId,
    message: error.message
  });
  return context.json({ success: false, error: "Failed to compact run snapshot" }, 500);
}

async function deleteRun(context: Context, services: RunRouteServices): Promise<Response> {
  const unexpectedBody = await rejectUnexpectedRequestBody(context);
  if (unexpectedBody !== null) return unexpectedBody;
  const runId = context.req.param("id")!;
  const run = await services.runService.delete(runId);
  clearRunLocalState(services, runId);
  await services.governanceLeaseService?.release(runId).catch(() => undefined);
  return context.json({ success: true, data: run }, 200);
}

function clearRunLocalState(services: RunRouteServices, runId: string): void {
  deleteRunSnapshotCache(runId);
  services.sessionOverrideService?.clearRun(runId);
  services.budgetBankruptcyService?.clearRun(runId);
  services.contextLensAssembler?.clearLens(runId);
}

function logRunRouteWarning(
  warn: RunRouteServices["warn"],
  message: string,
  meta: Record<string, unknown>
): void {
  (warn ?? defaultRunRouteWarning)(message, meta);
}

function defaultRunRouteWarning(message: string, meta: Record<string, unknown>): void {
  void message;
  void meta;
}

function parseRunRenameInput(runId: string, body: unknown): unknown {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new CoreError("VALIDATION", "Invalid request body");
  }

  try {
    return RunRenameInputSchema.parse({ run_id: runId, ...body });
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid request body", { cause: error });
  }
}
