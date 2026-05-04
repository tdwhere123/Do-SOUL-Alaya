import type { Hono } from "hono";
import { CoreError, type ConversationService, type RunHotStateService, type RunService } from "@do-soul/alaya-core";
import { parseJsonBody } from "./shared.js";
import {
  type EventLogEntry,
  RunInterruptResultSchema,
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
  app.post("/workspaces/:id/runs", async (context) => {
    const run = await services.runService.create(
      context.req.param("id"),
      await parseJsonBody(context.req.json.bind(context.req))
    );

    return context.json({ success: true, data: run }, 201);
  });

  app.get("/workspaces/:id/runs", async (context) => {
    const runs = await services.runService.listByWorkspace(context.req.param("id"));
    return context.json({ success: true, data: runs }, 200);
  });

  app.get("/runs/:id", async (context) => {
    const run = await services.runService.getById(context.req.param("id"));
    return context.json({ success: true, data: run }, 200);
  });

  app.get("/runs/:id/messages", async (context) => {
    const messages = await services.conversationService.listMessages(context.req.param("id"));
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

  app.post("/runs/:id/interrupt", async (context) => {
    const runId = context.req.param("id");
    const result = await services.conversationService.interruptRun(runId);

    return context.json({ success: true, data: RunInterruptResultSchema.parse(result) }, 200);
  });

  app.get("/runs/:id/snapshot", async (context) => {
    const runId = context.req.param("id");
    await services.runService.getById(runId);
    const snapshot = await services.runHotStateService.getSnapshot(runId);

    if (snapshot === null) {
      throw new CoreError("NOT_FOUND", "Run not found");
    }

    try {
      return context.json(
        { success: true, data: await enrichRunSnapshot(snapshot, runId, services.eventLogRepo, services.warn) },
        200
      );
    } catch (error) {
      if (error instanceof SnapshotCompactionError) {
        logRunRouteWarning(services.warn, "[daemon] snapshot compaction failed", {
          runId,
          message: error.message
        });

        return context.json(
          {
            success: false,
            error: "Failed to compact run snapshot"
          },
          500
        );
      }

      throw error;
    }
  });

  app.patch("/runs/:id", async (context) => {
    const runId = context.req.param("id");
    const body = await parseJsonBody(context.req.json.bind(context.req));
    const run = await services.runService.rename({ run_id: runId, ...(body as Record<string, unknown>) });
    return context.json({ success: true, data: run }, 200);
  });

  app.delete("/runs/:id", async (context) => {
    const runId = context.req.param("id");
    const run = await services.runService.delete(runId);
    deleteRunSnapshotCache(runId);
    services.sessionOverrideService?.clearRun(runId);
    services.budgetBankruptcyService?.clearRun(runId);
    services.contextLensAssembler?.clearLens(runId);

    // The run delete is already durable; lease release must stay best-effort so
    // stale in-process state cannot survive a successful delete.
    await services.governanceLeaseService?.release(runId).catch(() => undefined);

    return context.json({ success: true, data: run }, 200);
  });
}

function logRunRouteWarning(
  warn: RunRouteServices["warn"],
  message: string,
  meta: Record<string, unknown>
): void {
  (warn ?? defaultRunRouteWarning)(message, meta);
}

function defaultRunRouteWarning(message: string, meta: Record<string, unknown>): void {
  console.warn(message, meta);
}
