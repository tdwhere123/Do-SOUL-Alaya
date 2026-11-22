import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { capableRecallConsumerDeclaration, CoreError, type WorkspaceService } from "@do-soul/alaya-core";
import { toPublicToolError } from "@do-soul/alaya-protocol";
import { HTTP_REVIEWER_AGENT_TARGET } from "../../../mcp-memory/proposal/reviewer-surfaces.js";
import type { McpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";
import { jsonError, mcpToolErrorStatus, readJsonObject } from "../../shared/shared.js";

export interface SoulSearchRouteServices {
  readonly workspaceService: WorkspaceService;
  // invariant: the search route forwards to soul.recall through the same MCP
  // handler attached agents use, so ranking, governance scoping, and the
  // timeFilter coarse-pre-filter all share one code path.
  readonly mcpMemoryToolHandler: McpMemoryToolHandler;
}

// HTTP route surface for the loopback NL+time search endpoint.
//
//   POST /workspaces/:wsId/soul/search
//     body: { text: string, since?: string|null, until?: string|null,
//             time_field?: "created_at"|"last_used_at",
//             max_results?: number }
//     resp: { success: true, data: SoulMemorySearchResponse }
//
// invariant: the route never mutates memory; it forwards to soul.recall via
// the same MCP handler attached agents use, so deliveries / usage records
// flow through the standard governance loop.
export function registerSoulSearchRoutes(app: Hono, services: SoulSearchRouteServices): void {
  app.post("/workspaces/:wsId/soul/search", async (context) => {
    const workspaceId = context.req.param("wsId");
    await services.workspaceService.getById(workspaceId);

    const body = await readJsonObject(context);
    if (body === null) {
      return jsonError(context, 400, "invalid JSON body");
    }

    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (text.length === 0) {
      return jsonError(context, 400, "text is required");
    }
    const maxResults = clampMaxResults(body.max_results);
    // invariant: malformed `since` / `until` / `time_field` reach the route
    // boundary as a 400 instead of being silently coerced to undefined and
    // bypassing the recall schema. The MCP tool already validates good
    // values; the route is responsible for distinguishing "absent" from
    // "wrong type".
    let since: string | null | undefined;
    let until: string | null | undefined;
    try {
      since = parseOptionalIsoDatetime(body.since);
      until = parseOptionalIsoDatetime(body.until);
    } catch (error) {
      if (error instanceof CoreError && error.code === "VALIDATION") {
        return jsonError(context, 400, "invalid datetime", { error_code: error.code });
      }
      throw error;
    }
    let timeField: "created_at" | "last_used_at" | undefined;
    if (body.time_field === undefined) {
      timeField = undefined;
    } else if (body.time_field === "last_used_at" || body.time_field === "created_at") {
      timeField = body.time_field;
    } else {
      return jsonError(context, 400, "time_field must be 'created_at' or 'last_used_at'");
    }

    const args: Record<string, unknown> = {
      ...capableRecallConsumerDeclaration(),
      query: text,
      scope_class: null,
      dimension: null,
      domain_tags: null,
      max_results: maxResults
    };
    if (since !== undefined) args.since = since;
    if (until !== undefined) args.until = until;
    if (timeField !== undefined) args.time_field = timeField;

    const result = await services.mcpMemoryToolHandler.call({
      toolName: "soul.recall",
      arguments: args,
      context: {
        workspaceId,
        runId: null,
        agentTarget: HTTP_REVIEWER_AGENT_TARGET,
        sessionId: `${HTTP_REVIEWER_AGENT_TARGET}-${randomUUID()}`
      }
    });

    if (!result.ok) {
      return jsonError(
        context,
        mcpToolErrorStatus(result.error.code),
        toPublicToolError(result.error.code, result.error.message)
      );
    }
    return context.json({ success: true, data: result.output }, 200);
  });
}

const DEFAULT_MAX_RESULTS = 30;
const HARD_MAX_RESULTS = 100;

function clampMaxResults(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_MAX_RESULTS;
  return Math.max(1, Math.min(HARD_MAX_RESULTS, Math.floor(raw)));
}

function parseOptionalIsoDatetime(raw: unknown): string | null | undefined {
  if (raw === null) return null;
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") {
    throw new CoreError("VALIDATION", "invalid datetime");
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // SoulMemorySearchRequestSchema enforces UTC `Z` suffix and rejects bad
  // patterns; this route-side parse just shapes the type and surfaces a
  // 400 for non-string inputs that the schema would otherwise see as
  // "absent".
  return trimmed;
}
