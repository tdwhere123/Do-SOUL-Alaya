import type { MemoryEntry, ScopeClass } from "@do-soul/alaya-protocol";
import type { MemoryListPageOptions, MemoryServiceMemoryEntryRepoPort } from "./types.js";

const MEMORY_SERVICE_SCAN_PAGE_LIMIT = 500;

async function collectMemoryPages(
  readPage: (page: MemoryListPageOptions) => Promise<readonly Readonly<MemoryEntry>[]>
): Promise<readonly Readonly<MemoryEntry>[]> {
  const rows: Readonly<MemoryEntry>[] = [];
  for (let offset = 0; ; offset += MEMORY_SERVICE_SCAN_PAGE_LIMIT) {
    const pageRows = await readPage({
      limit: MEMORY_SERVICE_SCAN_PAGE_LIMIT,
      offset
    });
    rows.push(...pageRows);
    if (pageRows.length < MEMORY_SERVICE_SCAN_PAGE_LIMIT) {
      break;
    }
  }
  return Object.freeze(rows);
}

export interface MemoryQueryServiceDependencies {
  readonly memoryEntryRepo: MemoryServiceMemoryEntryRepoPort;
}

// invariant: read-side queries never decide durable truth; scoped lookups hide
// cross-workspace rows so callers cannot distinguish them from missing objects.
export class MemoryQueryService {
  private readonly memoryEntryRepo: MemoryServiceMemoryEntryRepoPort;

  public constructor(dependencies: MemoryQueryServiceDependencies) {
    this.memoryEntryRepo = dependencies.memoryEntryRepo;
  }

  public findById(objectId: string): Promise<Readonly<MemoryEntry> | null> {
    return this.memoryEntryRepo.findById(objectId);
  }

  // invariant: scoped lookup returns null for cross-workspace rows so handlers
  // cannot distinguish them from missing objects.
  public async findByIdScoped(
    objectId: string,
    workspaceId: string
  ): Promise<Readonly<MemoryEntry> | null> {
    const entry = await this.memoryEntryRepo.findById(objectId);
    if (entry === null || entry.workspace_id !== workspaceId) {
      return null;
    }
    return entry;
  }

  // invariant: scoped batch lookup hides cross-workspace rows the same way the
  // single-id scoped lookup does, so callers cannot distinguish hidden rows
  // from missing ones.
  public async findByIdsScoped(
    objectIds: readonly string[],
    workspaceId: string
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    const findByIds = this.memoryEntryRepo.findByIds;
    if (findByIds === undefined) {
      const entries = await Promise.all(
        objectIds.map(async (objectId) => await this.findByIdScoped(objectId, workspaceId))
      );
      return entries.filter((entry): entry is Readonly<MemoryEntry> => entry !== null);
    }

    const entries = await findByIds.call(this.memoryEntryRepo, objectIds);
    return entries.filter((entry) => entry.workspace_id === workspaceId);
  }

  public findByWorkspaceId(
    workspaceId: string,
    page?: MemoryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    return this.memoryEntryRepo.findByWorkspaceId(workspaceId, undefined, page);
  }

  public async findByWorkspaceIdAll(workspaceId: string): Promise<readonly Readonly<MemoryEntry>[]> {
    const findByWorkspaceIdAll = this.memoryEntryRepo.findByWorkspaceIdAll;
    if (findByWorkspaceIdAll !== undefined) {
      return await findByWorkspaceIdAll.call(this.memoryEntryRepo, workspaceId);
    }

    return await collectMemoryPages((page) =>
      this.memoryEntryRepo.findByWorkspaceId(workspaceId, undefined, page)
    );
  }

  public async countByWorkspaceId(workspaceId: string): Promise<number> {
    const countByWorkspaceId = this.memoryEntryRepo.countByWorkspaceId;
    if (countByWorkspaceId !== undefined) {
      return await countByWorkspaceId.call(this.memoryEntryRepo, workspaceId);
    }
    return (await this.findByWorkspaceIdAll(workspaceId)).length;
  }

  public findByRunId(
    runId: string,
    page?: MemoryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    return this.memoryEntryRepo.findByRunId(runId, page);
  }

  public async findByRunIdAll(runId: string): Promise<readonly Readonly<MemoryEntry>[]> {
    const findByRunIdAll = this.memoryEntryRepo.findByRunIdAll;
    if (findByRunIdAll !== undefined) {
      return await findByRunIdAll.call(this.memoryEntryRepo, runId);
    }

    return await collectMemoryPages((page) => this.memoryEntryRepo.findByRunId(runId, page));
  }

  public async countByRunId(runId: string): Promise<number> {
    const countByRunId = this.memoryEntryRepo.countByRunId;
    if (countByRunId !== undefined) {
      return await countByRunId.call(this.memoryEntryRepo, runId);
    }
    return (await this.findByRunIdAll(runId)).length;
  }

  public findByDimension(
    workspaceId: string,
    dimension: MemoryEntry["dimension"],
    page?: MemoryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    return this.memoryEntryRepo.findByDimension(workspaceId, dimension, page);
  }

  public async findByDimensionAll(
    workspaceId: string,
    dimension: MemoryEntry["dimension"]
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    const findByDimensionAll = this.memoryEntryRepo.findByDimensionAll;
    if (findByDimensionAll !== undefined) {
      return await findByDimensionAll.call(this.memoryEntryRepo, workspaceId, dimension);
    }

    return await collectMemoryPages((page) =>
      this.memoryEntryRepo.findByDimension(workspaceId, dimension, page)
    );
  }

  public async countByDimension(
    workspaceId: string,
    dimension: MemoryEntry["dimension"]
  ): Promise<number> {
    const countByDimension = this.memoryEntryRepo.countByDimension;
    if (countByDimension !== undefined) {
      return await countByDimension.call(this.memoryEntryRepo, workspaceId, dimension);
    }
    return (await this.findByDimensionAll(workspaceId, dimension)).length;
  }

  public findByScopeClass(
    workspaceId: string,
    scopeClass: ScopeClass,
    page?: MemoryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    if (page === undefined) {
      return this.memoryEntryRepo.findByScopeClass(workspaceId, scopeClass);
    }
    return this.memoryEntryRepo.findByScopeClass(workspaceId, scopeClass, page);
  }

  public async findByScopeClassAll(
    workspaceId: string,
    scopeClass: ScopeClass
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    const findByScopeClassAll = this.memoryEntryRepo.findByScopeClassAll;
    if (findByScopeClassAll !== undefined) {
      return await findByScopeClassAll.call(this.memoryEntryRepo, workspaceId, scopeClass);
    }

    return await collectMemoryPages((page) =>
      this.memoryEntryRepo.findByScopeClass(workspaceId, scopeClass, page)
    );
  }
}
