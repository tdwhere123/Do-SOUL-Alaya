import type { MemoryEntry, ScopeClass } from "@do-soul/alaya-protocol";
import type { MemoryEntryReadPort, MemoryListPageOptions } from "./types.js";

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
  readonly memoryEntryRepo: MemoryEntryReadPort;
}

// invariant: read-side queries never decide durable truth; scoped lookups hide
// cross-workspace rows so callers cannot distinguish them from missing objects.
export class MemoryQueryService {
  private readonly memoryEntryRepo: MemoryEntryReadPort;

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

    const entries = await findByIds.call(this.memoryEntryRepo, workspaceId, objectIds);
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

  public async countByScopeClass(
    workspaceId: string,
    scopeClass: ScopeClass
  ): Promise<number> {
    const countByScopeClass = this.memoryEntryRepo.countByScopeClass;
    if (countByScopeClass !== undefined) {
      return await countByScopeClass.call(this.memoryEntryRepo, workspaceId, scopeClass);
    }
    return (await this.findByScopeClassAll(workspaceId, scopeClass)).length;
  }

  public findByWorkspaceIdWithConflict(
    workspaceId: string,
    page?: MemoryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    const find = this.memoryEntryRepo.findByWorkspaceIdWithConflict;
    if (find === undefined) {
      throw new Error("findByWorkspaceIdWithConflict is not supported by memory entry repo");
    }
    return find.call(this.memoryEntryRepo, workspaceId, page);
  }

  public async countByWorkspaceIdWithConflict(workspaceId: string): Promise<number> {
    const count = this.memoryEntryRepo.countByWorkspaceIdWithConflict;
    if (count === undefined) {
      throw new Error("countByWorkspaceIdWithConflict is not supported by memory entry repo");
    }
    return await count.call(this.memoryEntryRepo, workspaceId);
  }

  public findByDimensionWithConflict(
    workspaceId: string,
    dimension: MemoryEntry["dimension"],
    page?: MemoryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    const find = this.memoryEntryRepo.findByDimensionWithConflict;
    if (find === undefined) {
      throw new Error("findByDimensionWithConflict is not supported by memory entry repo");
    }
    return find.call(this.memoryEntryRepo, workspaceId, dimension, page);
  }

  public async countByDimensionWithConflict(
    workspaceId: string,
    dimension: MemoryEntry["dimension"]
  ): Promise<number> {
    const count = this.memoryEntryRepo.countByDimensionWithConflict;
    if (count === undefined) {
      throw new Error("countByDimensionWithConflict is not supported by memory entry repo");
    }
    return await count.call(this.memoryEntryRepo, workspaceId, dimension);
  }

  public findByScopeClassWithConflict(
    workspaceId: string,
    scopeClass: ScopeClass,
    page?: MemoryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    const find = this.memoryEntryRepo.findByScopeClassWithConflict;
    if (find === undefined) {
      throw new Error("findByScopeClassWithConflict is not supported by memory entry repo");
    }
    return find.call(this.memoryEntryRepo, workspaceId, scopeClass, page);
  }

  public async countByScopeClassWithConflict(
    workspaceId: string,
    scopeClass: ScopeClass
  ): Promise<number> {
    const count = this.memoryEntryRepo.countByScopeClassWithConflict;
    if (count === undefined) {
      throw new Error("countByScopeClassWithConflict is not supported by memory entry repo");
    }
    return await count.call(this.memoryEntryRepo, workspaceId, scopeClass);
  }

  public findByScopeClassAndDimensionWithConflict(
    workspaceId: string,
    scopeClass: ScopeClass,
    dimension: MemoryEntry["dimension"],
    page?: MemoryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    const find = this.memoryEntryRepo.findByScopeClassAndDimensionWithConflict;
    if (find === undefined) {
      throw new Error("findByScopeClassAndDimensionWithConflict is not supported by memory entry repo");
    }
    return find.call(this.memoryEntryRepo, workspaceId, scopeClass, dimension, page);
  }

  public async countByScopeClassAndDimensionWithConflict(
    workspaceId: string,
    scopeClass: ScopeClass,
    dimension: MemoryEntry["dimension"]
  ): Promise<number> {
    const count = this.memoryEntryRepo.countByScopeClassAndDimensionWithConflict;
    if (count === undefined) {
      throw new Error("countByScopeClassAndDimensionWithConflict is not supported by memory entry repo");
    }
    return await count.call(this.memoryEntryRepo, workspaceId, scopeClass, dimension);
  }
}
