import type { Hono } from "hono";
import { CoreError, type MemoryService, type RunService, type WorkspaceService } from "@do-soul/alaya-core";
import { MemoryDimensionSchema, ScopeClassSchema, type ScopeClass } from "@do-soul/alaya-protocol";
import { parseListPagination, writeListPaginationHeaders } from "./shared.js";

export interface MemoryRouteServices {
  readonly workspaceService: WorkspaceService;
  readonly runService: RunService;
  readonly memoryService: MemoryService;
}

type MemoryListRow = Awaited<ReturnType<MemoryService["findByWorkspaceId"]>>[number];
type WorkspaceMemoryListInput = {
  readonly workspaceId: string;
  readonly dimension?: ReturnType<typeof parseDimension>;
  readonly scopeClass?: ScopeClass;
  readonly hasConflict?: boolean;
  readonly pagination: { readonly limit: number; readonly offset: number };
};

const MEMORY_SCAN_PAGE_LIMIT = 500;

// HTTP route surface intentionally omits GET /memories/:id.
// Per-memory reads must stay workspace-scoped per invariants §21 and §29:
//   - MCP: soul.open_pointer (mcp-memory/tool-handler, workspace-scoped)
//   - CLI fallback: alaya tools call --json '{"name":"soul.open_pointer", ...}'
//   - Inspector: GET /workspaces/:wsId/memories and scoped pointer routes
export function registerMemoryRoutes(app: Hono, services: MemoryRouteServices): void {
  app.get("/workspaces/:wsId/memories", async (context) => {
    const workspaceId = context.req.param("wsId");
    await services.workspaceService.getById(workspaceId);

    const dimension = context.req.query("dimension");
    const parsedDimension = dimension === undefined ? undefined : parseDimension(dimension);
    const scopeClass = context.req.query("scope_class");
    const parsedScopeClass = scopeClass === undefined ? undefined : parseScopeClass(scopeClass);
    const hasConflict = parseOptionalBoolean(context.req.query("has_conflict"), "has_conflict");
    const pagination = parseListPagination(context);
    const { memories, totalCount } = await listWorkspaceMemories(services.memoryService, {
      workspaceId,
      dimension: parsedDimension,
      scopeClass: parsedScopeClass,
      hasConflict,
      pagination
    });
    writeListPaginationHeaders(context, totalCount, pagination);

    return context.json({ success: true, data: memories }, 200);
  });

  app.get("/runs/:runId/memories", async (context) => {
    const runId = context.req.param("runId");
    await services.runService.getById(runId);

    const pagination = parseListPagination(context);
    const memories = await services.memoryService.findByRunId(runId, pagination);
    const totalCount = await services.memoryService.countByRunId(runId);
    writeListPaginationHeaders(context, totalCount, pagination);
    return context.json({ success: true, data: memories }, 200);
  });
}

function parseDimension(value: string) {
  try {
    return MemoryDimensionSchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid memory dimension", { cause: error });
  }
}

function parseScopeClass(value: string): ScopeClass {
  try {
    return ScopeClassSchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid scope_class", { cause: error });
  }
}

function parseOptionalBoolean(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new CoreError("VALIDATION", `${name} must be true or false`);
}

async function listWorkspaceMemories(
  memoryService: MemoryService,
  input: WorkspaceMemoryListInput
): Promise<{ readonly memories: readonly MemoryListRow[]; readonly totalCount: number }> {
  if (input.scopeClass !== undefined && input.hasConflict !== true && input.dimension === undefined) {
    const memories = await memoryService.findByScopeClass(
      input.workspaceId,
      input.scopeClass,
      input.pagination
    );
    const totalCount = await countWorkspaceMemoriesByScopeClass(memoryService, input);
    return { memories, totalCount };
  }

  const needsAuthoritativeFiltering = input.hasConflict === true;

  if (!needsAuthoritativeFiltering) {
    const memories =
      input.dimension === undefined
        ? await memoryService.findByWorkspaceId(input.workspaceId, input.pagination)
        : await memoryService.findByDimension(input.workspaceId, input.dimension, input.pagination);
    const totalCount =
      input.dimension === undefined
        ? await memoryService.countByWorkspaceId(input.workspaceId)
        : await memoryService.countByDimension(input.workspaceId, input.dimension);
    return { memories, totalCount };
  }

  const memories: MemoryListRow[] = [];
  let totalCount = 0;
  let scanOffset = 0;

  for (;;) {
    const page = await loadWorkspaceMemoryScanPage(memoryService, input, {
      limit: MEMORY_SCAN_PAGE_LIMIT,
      offset: scanOffset
    });

    if (page.length === 0) {
      break;
    }

    for (const memory of page) {
      if (!matchesWorkspaceMemoryListFilters(memory, input)) {
        continue;
      }

      if (totalCount >= input.pagination.offset && memories.length < input.pagination.limit) {
        memories.push(memory);
      }
      totalCount += 1;
    }

    if (page.length < MEMORY_SCAN_PAGE_LIMIT) {
      break;
    }
    scanOffset += MEMORY_SCAN_PAGE_LIMIT;
  }

  return {
    memories,
    totalCount
  };
}

async function loadWorkspaceMemoryScanPage(
  memoryService: MemoryService,
  input: WorkspaceMemoryListInput,
  page: { readonly limit: number; readonly offset: number }
): Promise<readonly MemoryListRow[]> {
  if (input.scopeClass !== undefined) {
    return await memoryService.findByScopeClass(input.workspaceId, input.scopeClass, page);
  }
  return input.dimension === undefined
    ? await memoryService.findByWorkspaceId(input.workspaceId, page)
    : await memoryService.findByDimension(input.workspaceId, input.dimension, page);
}

function matchesWorkspaceMemoryListFilters(
  memory: MemoryListRow,
  input: WorkspaceMemoryListInput
): boolean {
  if (input.dimension !== undefined && memory.dimension !== input.dimension) {
    return false;
  }
  if (input.scopeClass !== undefined && memory.scope_class !== input.scopeClass) {
    return false;
  }
  if (input.hasConflict === true && (memory.contradiction_count ?? 0) === 0) {
    return false;
  }
  return true;
}

async function countWorkspaceMemoriesByScopeClass(
  memoryService: MemoryService,
  input: WorkspaceMemoryListInput
): Promise<number> {
  if (input.scopeClass === undefined) {
    return 0;
  }
  let totalCount = 0;
  let scanOffset = 0;
  for (;;) {
    const batch = await memoryService.findByScopeClass(input.workspaceId, input.scopeClass, {
      limit: MEMORY_SCAN_PAGE_LIMIT,
      offset: scanOffset
    });
    if (batch.length === 0) {
      break;
    }
    totalCount += batch.length;
    if (batch.length < MEMORY_SCAN_PAGE_LIMIT) {
      break;
    }
    scanOffset += MEMORY_SCAN_PAGE_LIMIT;
  }
  return totalCount;
}
