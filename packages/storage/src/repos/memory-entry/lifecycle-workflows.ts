import type { MemoryEntry } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";
import {
  parseForgetDisposition,
  parseLifecycleState,
  parseMemoryEntryRow,
  parseUpdatedAt,
  type MemoryEntryRow
} from "./row-mapper.js";
import type { SqliteGetStatement, SqliteRunStatement } from "./statement-types.js";
import type { AutonomousTombstoneInput } from "./types.js";

export interface MemoryEntryLifecycleWorkflowHost {
  readonly db: StorageDatabase;
  readonly findByIdStatement: SqliteGetStatement;
  readonly transitionLifecycleStatement: SqliteRunStatement;
  readonly transitionLifecycleClearForgetStatement: SqliteRunStatement;
  readonly reviveDormantStatement: SqliteRunStatement;
  readonly demoteActiveToDormantStatement: SqliteRunStatement;
  readonly archiveStatement: SqliteRunStatement;
  readonly hardDeleteTombstonedStatement: SqliteRunStatement;
  readonly autonomousTombstoneStatement: SqliteRunStatement;
  readonly hardDeleteTombstonedWithDispositionStatement: SqliteRunStatement;
  readonly hardDeleteTombstonedCompressedGuardedStatement: SqliteRunStatement;
  readonly hardDeleteTombstonedJudgedUselessGuardedStatement: SqliteRunStatement;
  readonly deleteOrphanedPathRelationsStatement: SqliteRunStatement;
  readonly deleteOrphanedCoUsageCountersStatement: SqliteRunStatement;
  readonly findById: (objectId: string) => Promise<Readonly<MemoryEntry> | null>;
  transaction<T>(fn: () => T): T;
}

interface ParsedAutonomousTombstoneRequest {
  readonly disposition: ReturnType<typeof parseForgetDisposition>;
  readonly updatedAt: string;
}

export async function autonomousTombstone(
  this: MemoryEntryLifecycleWorkflowHost,
  input: AutonomousTombstoneInput,
  options?: { readonly onTransition?: () => void }
): Promise<Readonly<MemoryEntry>> {
  const request = parseAutonomousTombstoneRequest(input);
  const onTransition = options?.onTransition;

  try {
    return this.transaction(() => {
      const result = this.autonomousTombstoneStatement.run(
        request.disposition,
        input.dispositionRef,
        request.updatedAt,
        input.objectId
      );

      if (result.changes === 0) {
        throw new StorageError(
          "NOT_FOUND",
          `Memory entry ${input.objectId} was not found or is not dormant (not eligible for autonomous tombstone).`
        );
      }

      onTransition?.();

      return loadMemoryEntryAfterTransition(this, input.objectId, "autonomous tombstone");
    });
  } catch (error) {
    if (error instanceof StorageError) {
      throw error;
    }

    throw new StorageError(
      "QUERY_FAILED",
      `Failed to autonomously tombstone memory entry ${input.objectId}.`,
      error
    );
  }
}

function parseAutonomousTombstoneRequest(
  input: AutonomousTombstoneInput
): ParsedAutonomousTombstoneRequest {
  const disposition = parseForgetDisposition(input.disposition);
  if (disposition === "judged_useless" && input.dispositionRef !== null) {
    throw new StorageError(
      "VALIDATION_FAILED",
      "judged_useless disposition must not carry a disposition ref."
    );
  }
  if (disposition === "compressed" && input.dispositionRef === null) {
    throw new StorageError(
      "VALIDATION_FAILED",
      "compressed disposition requires a live synthesis-capsule ref."
    );
  }
  return { disposition, updatedAt: parseUpdatedAt(input.updatedAt) };
}

function loadMemoryEntryAfterTransition(
  host: MemoryEntryLifecycleWorkflowHost,
  objectId: string,
  transitionName: string
): Readonly<MemoryEntry> {
  const updated = host.findByIdStatement.get(objectId) as MemoryEntryRow | undefined;
  if (updated === undefined) {
    throw new StorageError(
      "NOT_FOUND",
      `Memory entry ${objectId} was not found after ${transitionName}.`
    );
  }
  return parseMemoryEntryRow(updated);
}

export async function hardDeleteTombstonedWithDisposition(
  this: MemoryEntryLifecycleWorkflowHost,
  objectId: string,
  options?: {
    readonly requireLiveCapsuleRef?: boolean;
    readonly requireJudgedUselessVerdict?: boolean;
    readonly onDeleted?: () => void;
  }
): Promise<boolean> {
  const requireLiveCapsuleRef = options?.requireLiveCapsuleRef === true;
  const requireJudgedUselessVerdict = options?.requireJudgedUselessVerdict === true;
  const onDeleted = options?.onDeleted;
  try {
    if (requireLiveCapsuleRef && requireJudgedUselessVerdict) {
      throw new StorageError(
        "VALIDATION_FAILED",
        "A disposition-gated delete cannot require both compressed-capsule and judged_useless verdict guards."
      );
    }

    return this.transaction(() => {
      if (requireLiveCapsuleRef) {
        return deleteCompressedTombstone(this, objectId, onDeleted);
      }

      return deleteDispositionTombstone(this, objectId, requireJudgedUselessVerdict, onDeleted);
    });
  } catch (error) {
    if (error instanceof StorageError) {
      throw error;
    }

    throw new StorageError(
      "QUERY_FAILED",
      `Failed to autonomously hard-delete memory entry ${objectId}.`,
      error
    );
  }
}

function deleteCompressedTombstone(
  host: MemoryEntryLifecycleWorkflowHost,
  objectId: string,
  onDeleted: (() => void) | undefined
): boolean {
  const guarded = host.hardDeleteTombstonedCompressedGuardedStatement.run(objectId);
  if (guarded.changes === 0) {
    return false;
  }
  pruneDeletedMemoryGraph(host, objectId, onDeleted);
  return true;
}

function deleteDispositionTombstone(
  host: MemoryEntryLifecycleWorkflowHost,
  objectId: string,
  requireJudgedUselessVerdict: boolean,
  onDeleted: (() => void) | undefined
): boolean {
  const result = requireJudgedUselessVerdict
    ? host.hardDeleteTombstonedJudgedUselessGuardedStatement.run(objectId)
    : host.hardDeleteTombstonedWithDispositionStatement.run(objectId);
  if (result.changes === 0) {
    return handleDispositionDeleteMiss(objectId, requireJudgedUselessVerdict);
  }
  pruneDeletedMemoryGraph(host, objectId, onDeleted);
  return true;
}

function handleDispositionDeleteMiss(objectId: string, guardedDelete: boolean): false {
  if (guardedDelete) {
    return false;
  }
  throw new StorageError(
    "NOT_FOUND",
    `Tombstoned memory entry ${objectId} was not found, lacks a forget disposition, or is within the grace window (not eligible for autonomous GC).`
  );
}

function pruneDeletedMemoryGraph(
  host: MemoryEntryLifecycleWorkflowHost,
  objectId: string,
  onDeleted: (() => void) | undefined
): void {
  onDeleted?.();
  host.deleteOrphanedPathRelationsStatement.run(objectId, objectId);
  host.deleteOrphanedCoUsageCountersStatement.run(objectId, objectId);
}

export async function archiveMemoryEntry(
  this: MemoryEntryLifecycleWorkflowHost,
  objectId: string,
  updatedAt: string,
  onArchived?: () => void
): Promise<Readonly<MemoryEntry>> {
  const parsedUpdatedAt = parseUpdatedAt(updatedAt);

  try {
    return this.transaction(() => {
      onArchived?.();

      const result = this.archiveStatement.run(parsedUpdatedAt, objectId);

      if (result.changes === 0) {
        throw new StorageError("NOT_FOUND", `Memory entry ${objectId} was not found.`);
      }

      const archived = this.findByIdStatement.get(objectId) as MemoryEntryRow | undefined;

      if (archived === undefined) {
        throw new StorageError("NOT_FOUND", `Memory entry ${objectId} was not found after archive.`);
      }

      return parseMemoryEntryRow(archived);
    });
  } catch (error) {
    if (error instanceof StorageError) {
      throw error;
    }

    throw new StorageError("QUERY_FAILED", `Failed to archive memory entry ${objectId}.`, error);
  }
}

export async function transitionMemoryEntryLifecycle(
  this: MemoryEntryLifecycleWorkflowHost,
  objectId: string,
  lifecycleState: MemoryEntry["lifecycle_state"],
  updatedAt: string,
  onTransition?: () => void
): Promise<Readonly<MemoryEntry>> {
  const parsedLifecycleState = parseLifecycleState(lifecycleState);
  const parsedUpdatedAt = parseUpdatedAt(updatedAt);

  try {
    return this.transaction(() => {
      onTransition?.();

      // invariant (I3): non-tombstone transitions clear the disposition GC marker.
      const statement =
        parsedLifecycleState === "tombstone"
          ? this.transitionLifecycleStatement
          : this.transitionLifecycleClearForgetStatement;
      const result = statement.run(parsedLifecycleState, parsedUpdatedAt, objectId);

      if (result.changes === 0) {
        throw new StorageError("NOT_FOUND", `Memory entry ${objectId} was not found.`);
      }

      const updated = this.findByIdStatement.get(objectId) as MemoryEntryRow | undefined;

      if (updated === undefined) {
        throw new StorageError("NOT_FOUND", `Memory entry ${objectId} was not found after lifecycle update.`);
      }

      return parseMemoryEntryRow(updated);
    });
  } catch (error) {
    if (error instanceof StorageError) {
      throw error;
    }

    throw new StorageError(
      "QUERY_FAILED",
      `Failed to transition lifecycle for memory entry ${objectId}.`,
      error
    );
  }
}

export async function reviveDormantMemoryEntry(
  this: MemoryEntryLifecycleWorkflowHost,
  objectId: string,
  updatedAt: string
): Promise<Readonly<MemoryEntry> | null> {
  const parsedUpdatedAt = parseUpdatedAt(updatedAt);
  try {
    const result = this.reviveDormantStatement.run(parsedUpdatedAt, objectId);
    if (result.changes === 0) {
      return null;
    }
    const updated = await this.findById(objectId);
    if (updated === null) {
      throw new StorageError("NOT_FOUND", `Memory entry ${objectId} was not found after revival.`);
    }
    return updated;
  } catch (error) {
    if (error instanceof StorageError) {
      throw error;
    }
    throw new StorageError("QUERY_FAILED", `Failed to revive dormant memory entry ${objectId}.`, error);
  }
}

export async function transitionMemoryEntryToDormantIfActive(
  this: MemoryEntryLifecycleWorkflowHost,
  objectId: string,
  updatedAt: string,
  onTransition?: () => void
): Promise<Readonly<MemoryEntry> | null> {
  const parsedUpdatedAt = parseUpdatedAt(updatedAt);
  try {
    const demoted = this.transaction(() => {
      const result = this.demoteActiveToDormantStatement.run(parsedUpdatedAt, objectId);
      if (result.changes === 0) {
        return false;
      }
      onTransition?.();
      return true;
    });
    if (!demoted) {
      return null;
    }
    const updated = await this.findById(objectId);
    if (updated === null) {
      throw new StorageError("NOT_FOUND", `Memory entry ${objectId} was not found after dormant demotion.`);
    }
    return updated;
  } catch (error) {
    if (error instanceof StorageError) {
      throw error;
    }
    throw new StorageError(
      "QUERY_FAILED",
      `Failed to demote active memory entry ${objectId} to dormant.`,
      error
    );
  }
}

export async function hardDeleteTombstonedMemoryEntry(
  this: MemoryEntryLifecycleWorkflowHost,
  objectId: string,
  onDeleted?: () => void
): Promise<void> {
  try {
    this.transaction(() => {
      onDeleted?.();

      const result = this.hardDeleteTombstonedStatement.run(objectId);

      if (result.changes === 0) {
        throw new StorageError(
          "NOT_FOUND",
          `Tombstoned memory entry ${objectId} was not found or is not eligible for deletion.`
        );
      }

      // invariant: ineligible tombstones never strip live path topology.
      this.deleteOrphanedPathRelationsStatement.run(objectId, objectId);
      this.deleteOrphanedCoUsageCountersStatement.run(objectId, objectId);
    });
  } catch (error) {
    if (error instanceof StorageError) {
      throw error;
    }

    throw new StorageError(
      "QUERY_FAILED",
      `Failed to hard-delete tombstoned memory entry ${objectId}.`,
      error
    );
  }
}
