import type { Hono } from "hono";
import {
  CoreError,
  type RecallService,
  type RunService,
  type TaskSurfaceBuilder,
  type WorkspaceService
} from "@do-what/core";

const STRATEGY_VALUES = new Set(["chat", "analyze", "build", "govern"]);

export interface RecallRouteServices {
  readonly recallService: RecallService;
  readonly taskSurfaceBuilder: TaskSurfaceBuilder;
  readonly runService: RunService;
  readonly workspaceService: WorkspaceService;
}

export function registerRecallRoutes(app: Hono, services: RecallRouteServices): void {
  // Debug/inspection endpoints: each HTTP request builds a fresh TaskObjectSurface snapshot (not turn-lifecycle managed).
  app.get("/runs/:runId/task-surface", async (context) => {
    const run = await services.runService.getById(context.req.param("runId"));
    await services.workspaceService.getById(run.workspace_id);

    const taskSurface = await services.taskSurfaceBuilder.build({
      run,
      surfaceId: run.current_surface_id,
      displayName: resolveDisplayName(run.title, run.run_id)
    });

    return context.json({ success: true, data: taskSurface }, 200);
  });

  app.get("/runs/:runId/recall-candidates", async (context) => {
    const run = await services.runService.getById(context.req.param("runId"));
    await services.workspaceService.getById(run.workspace_id);

    const taskSurface = await services.taskSurfaceBuilder.build({
      run,
      surfaceId: run.current_surface_id,
      displayName: resolveDisplayName(run.title, run.run_id)
    });

    const strategy = parseStrategyQuery(context.req.query("strategy")) ?? services.taskSurfaceBuilder.resolveStrategy(taskSurface.surface_kind);
    const result = await services.recallService.recall({
      taskSurface,
      workspaceId: run.workspace_id,
      runId: run.run_id,
      strategy
    });

    return context.json({ success: true, data: result }, 200);
  });
}

function parseStrategyQuery(value: string | undefined): "chat" | "analyze" | "build" | "govern" | null {
  if (value === undefined) {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (!STRATEGY_VALUES.has(normalized)) {
    throw new CoreError("VALIDATION", "strategy must be one of chat, analyze, build, govern");
  }

  return normalized as "chat" | "analyze" | "build" | "govern";
}

function resolveDisplayName(title: string, runId: string): string {
  const trimmed = title.trim();
  return trimmed.length > 0 ? trimmed : `Run ${runId}`;
}