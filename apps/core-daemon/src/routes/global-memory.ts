import type { GlobalMemoryEntry, ProjectMappingAnchor } from "@do-soul/alaya-protocol";
import {
  AcceptedBy,
  AcceptedBySchema,
  MemoryDimensionSchema,
  ScopeClassSchema
} from "@do-soul/alaya-protocol";
import type { Hono } from "hono";
import { CoreError, type WorkspaceService } from "@do-soul/alaya-core";
import { throwInvalidRequestBody } from "./shared.js";

export type GlobalMemoryEntryRecord = GlobalMemoryEntry;

export interface GlobalMemoryListInput {
  readonly dimension?: GlobalMemoryEntry["dimension"];
  readonly scope_class?: GlobalMemoryEntry["scope_class"];
  readonly limit: number;
}

export interface GlobalMemoryAdoptInput {
  readonly workspace_id: string;
  readonly accepted_by: AcceptedBy;
}

export interface GlobalMemoryRouteService {
  list(input: GlobalMemoryListInput): Promise<readonly Readonly<GlobalMemoryEntryRecord>[]>;
  adopt(globalObjectId: string, input: GlobalMemoryAdoptInput): Promise<Readonly<ProjectMappingAnchor>>;
}

export interface GlobalMemoryRouteServices {
  readonly workspaceService: WorkspaceService;
  readonly globalMemoryService: GlobalMemoryRouteService;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export function registerGlobalMemoryRoutes(app: Hono, services: GlobalMemoryRouteServices): void {
  app.get("/soul/global-memory-entries", async (context) => {
    const input = parseListInput({
      dimension: context.req.query("dimension"),
      scope_class: context.req.query("scope_class"),
      limit: context.req.query("limit")
    });
    const entries = await services.globalMemoryService.list(input);

    return context.json(
      {
        success: true,
        data: {
          entries,
          total: entries.length
        }
      },
      200
    );
  });

  app.post("/soul/global-memory-entries/:id/adopt", async (context) => {
    const globalObjectId = parseRequiredString(context.req.param("id"), "id is required");
    const input = await parseAdoptInput(context.req.json.bind(context.req));
    await services.workspaceService.getById(input.workspace_id);
    const anchor = await services.globalMemoryService.adopt(globalObjectId, input);

    return context.json(
      {
        success: true,
        data: {
          anchor
        }
      },
      200
    );
  });
}

function parseListInput(query: {
  readonly dimension?: string;
  readonly scope_class?: string;
  readonly limit?: string;
}): GlobalMemoryListInput {
  const parsedDimension = parseOptionalEnum(
    query.dimension,
    MemoryDimensionSchema,
    "dimension must be a valid memory dimension"
  );
  const parsedScopeClass = parseOptionalEnum(
    query.scope_class,
    ScopeClassSchema,
    "scope_class must be a valid scope class"
  );

  return {
    ...(parsedDimension === undefined ? {} : { dimension: parsedDimension }),
    ...(parsedScopeClass === undefined ? {} : { scope_class: parsedScopeClass }),
    limit: parseOptionalLimit(query.limit)
  };
}

async function parseAdoptInput(readJson: () => Promise< unknown>): Promise<GlobalMemoryAdoptInput> {
  const body = await parseJsonObject(readJson, "Global memory adopt request body must be an object");

  return {
    workspace_id: parseRequiredString(body.workspace_id, "workspace_id is required"),
    accepted_by: parseOptionalAcceptedBy(body.accepted_by) ?? AcceptedBy.USER
  };
}

async function parseJsonObject(
  readJson: () => Promise< unknown>,
  objectMessage: string
): Promise<Record<string, unknown>> {
  let body: unknown;

  try {
    body = await readJson();
  } catch (error) {
    throwInvalidRequestBody(error);
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new CoreError("VALIDATION", objectMessage);
  }

  return body as Record<string, unknown>;
}

function parseRequiredString(value: unknown, message: string): string {
  if (typeof value !== "string") {
    throw new CoreError("VALIDATION", message);
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new CoreError("VALIDATION", message);
  }

  return trimmed;
}

function parseOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function parseOptionalEnum<T>(
  value: string | undefined,
  schema: {
    safeParse(value: unknown): { success: boolean; data?: T; error?: unknown };
  },
  message: string
): T | undefined {
  const parsedValue = parseOptionalString(value);

  if (parsedValue === undefined) {
    return undefined;
  }

  const result = schema.safeParse(parsedValue);
  if (!result.success) {
    throw new CoreError("VALIDATION", message, {
      cause: result.error
    });
  }

  return result.data;
}

function parseOptionalLimit(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_LIMIT;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
    throw new CoreError("VALIDATION", `limit must be an integer between 1 and ${MAX_LIMIT}`);
  }

  return parsed;
}

function parseOptionalAcceptedBy(value: unknown): AcceptedBy | undefined {
  if (value === undefined) {
    return undefined;
  }

  const result = AcceptedBySchema.safeParse(value);
  if (!result.success) {
    throw new CoreError("VALIDATION", "accepted_by must be a valid accepted-by value", {
      cause: result.error
    });
  }

  return result.data;
}
