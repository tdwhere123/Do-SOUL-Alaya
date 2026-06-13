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
}

export async function autonomousTombstone(
  this: MemoryEntryLifecycleWorkflowHost,
  input: AutonomousTombstoneInput,
  options?: { readonly onTransition?: () => void }
): Promise<Readonly<MemoryEntry>> {
  const parsedDisposition = parseForgetDisposition(input.disposition);
  // invariant: disposition refs are validated before writing the durable marker.
  if (parsedDisposition === "judged_useless" && input.dispositionRef !== null) {
    throw new StorageError(
      "VALIDATION_FAILED",
      "judged_useless disposition must not carry a disposition ref."
    );
  }
  if (parsedDisposition === "compressed" && input.dispositionRef === null) {
    throw new StorageError(
      "VALIDATION_FAILED",
      "compressed disposition requires a live synthesis-capsule ref."
    );
  }
  const parsedUpdatedAt = parseUpdatedAt(input.updatedAt);
  const onTransition = options?.onTransition;

  try {
    return this.db.connection.transaction(() => {
      const result = this.autonomousTombstoneStatement.run(
        parsedDisposition,
        input.dispositionRef,
        parsedUpdatedAt,
        input.objectId
      );

      if (result.changes === 0) {
        throw new StorageError(
          "NOT_FOUND",
          `Memory entry ${input.objectId} was not found or is not dormant (not eligible for autonomous tombstone).`
        );
      }

      onTransition?.();

      const updated = this.findByIdStatement.get(input.objectId) as MemoryEntryRow | undefined;
      if (updated === undefined) {
        throw new StorageError(
          "NOT_FOUND",
          `Memory entry ${input.objectId} was not found after autonomous tombstone.`
        );
      }

      return parseMemoryEntryRow(updated);
    })();
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

    return this.db.connection.transaction(() => {
      // invariant: compressed deletion rechecks capsule preservation in the DELETE.
      if (requireLiveCapsuleRef) {
        const guarded = this.hardDeleteTombstonedCompressedGuardedStatement.run(objectId);
        if (guarded.changes === 0) {
          return false;
        }
        // invariant: terminal-removal audit appends only after a real delete in this transaction.
        onDeleted?.();
        this.deleteOrphanedPathRelationsStatement.run(objectId, objectId);
        this.deleteOrphanedCoUsageCountersStatement.run(objectId, objectId);
        return true;
      }

      const result = requireJudgedUselessVerdict
        ? this.hardDeleteTombstonedJudgedUselessGuardedStatement.run(objectId)
        : this.hardDeleteTombstonedWithDispositionStatement.run(objectId);

      if (result.changes === 0) {
        if (requireJudgedUselessVerdict) {
          return false;
        }
        throw new StorageError(
          "NOT_FOUND",
          `Tombstoned memory entry ${objectId} was not found, lacks a forget disposition, or is within the grace window (not eligible for autonomous GC).`
        );
      }

      onDeleted?.();

      // invariant: topology is pruned only after the disposition-gated row is deleted.
      this.deleteOrphanedPathRelationsStatement.run(objectId, objectId);
      this.deleteOrphanedCoUsageCountersStatement.run(objectId, objectId);
      return true;
    })();
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

export async function archiveMemoryEntry(
  this: MemoryEntryLifecycleWorkflowHost,
  objectId: string,
  updatedAt: string
): Promise<Readonly<MemoryEntry>> {
  const parsedUpdatedAt = parseUpdatedAt(updatedAt);

  try {
    const result = this.archiveStatement.run(parsedUpdatedAt, objectId);

    if (result.changes === 0) {
      throw new StorageError("NOT_FOUND", `Memory entry ${objectId} was not found.`);
    }

    const archived = await this.findById(objectId);

    if (archived === null) {
      throw new StorageError("NOT_FOUND", `Memory entry ${objectId} was not found after archive.`);
    }

    return archived;
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
  updatedAt: string
): Promise<Readonly<MemoryEntry>> {
  const parsedLifecycleState = parseLifecycleState(lifecycleState);
  const parsedUpdatedAt = parseUpdatedAt(updatedAt);

  try {
    // invariant (I3): non-tombstone transitions clear the disposition GC marker.
    const statement =
      parsedLifecycleState === "tombstone"
        ? this.transitionLifecycleStatement
        : this.transitionLifecycleClearForgetStatement;
    const result = statement.run(parsedLifecycleState, parsedUpdatedAt, objectId);

    if (result.changes === 0) {
      throw new StorageError("NOT_FOUND", `Memory entry ${objectId} was not found.`);
    }

    const updated = await this.findById(objectId);

    if (updated === null) {
      throw new StorageError("NOT_FOUND", `Memory entry ${objectId} was not found after lifecycle update.`);
    }

    return updated;
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
    const demoted = this.db.connection.transaction(() => {
      const result = this.demoteActiveToDormantStatement.run(parsedUpdatedAt, objectId);
      if (result.changes === 0) {
        return false;
      }
      onTransition?.();
      return true;
    })();
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
  objectId: string
): Promise<void> {
  try {
    this.db.connection.transaction(() => {
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
    })();
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
