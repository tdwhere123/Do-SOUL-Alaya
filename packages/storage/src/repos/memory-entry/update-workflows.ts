import { StorageTier, type MemoryEntry } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../db.js";
import { StorageError } from "../../errors.js";
import { parseNonEmptyString } from "../shared/validators.js";
import {
  parseDynamicsUpdateFields,
  parseMemoryEntryRow,
  parseStorageTier,
  parseUpdatedAt,
  parseUpdateFields,
  type MemoryEntryRow
} from "./row-mapper.js";
import type { SqliteGetStatement, SqliteRunStatement } from "./statement-types.js";
import type {
  MemoryEntryRepoDynamicsUpdateFields,
  MemoryEntryRepoTierUpdateInput,
  MemoryEntryRepoUpdateFields
} from "./types.js";

export interface MemoryEntryUpdateWorkflowHost {
  readonly db: StorageDatabase;
  readonly updateStatement: SqliteRunStatement;
  readonly updateScopedStatement: SqliteRunStatement;
  readonly findByIdStatement: SqliteGetStatement;
  readonly findById: (objectId: string) => Promise<Readonly<MemoryEntry> | null>;
}

export async function updateMemoryEntry(
  this: MemoryEntryUpdateWorkflowHost,
  objectId: string,
  fields: MemoryEntryRepoUpdateFields
): Promise<Readonly<MemoryEntry>> {
  const parsedFields = parseUpdateFields(fields);

  try {
    const result = this.updateStatement.run(
      parsedFields.content ?? null,
      parsedFields.domain_tags === undefined ? null : JSON.stringify(parsedFields.domain_tags),
      parsedFields.evidence_refs === undefined ? null : JSON.stringify(parsedFields.evidence_refs),
      parsedFields.storage_tier ?? null,
      parsedFields.confidence ?? null,
      parsedFields.retention_state ?? null,
      parsedFields.last_used_at ?? null,
      parsedFields.last_hit_at ?? null,
      parsedFields.updated_at,
      objectId
    );

    if (result.changes === 0) {
      throw new StorageError("NOT_FOUND", `Memory entry ${objectId} was not found.`);
    }

    const updated = await this.findById(objectId);

    if (updated === null) {
      throw new StorageError("NOT_FOUND", `Memory entry ${objectId} was not found after update.`);
    }

    return updated;
  } catch (error) {
    if (error instanceof StorageError) {
      throw error;
    }

    throw new StorageError("QUERY_FAILED", `Failed to update memory entry ${objectId}.`, error);
  }
}

export async function updateScopedMemoryEntry(
  this: MemoryEntryUpdateWorkflowHost,
  objectId: string,
  workspaceId: string,
  fields: MemoryEntryRepoUpdateFields
): Promise<Readonly<MemoryEntry>> {
  const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace_id");
  const parsedFields = parseUpdateFields(fields);

  try {
    const result = this.updateScopedStatement.run(
      parsedFields.content ?? null,
      parsedFields.domain_tags === undefined ? null : JSON.stringify(parsedFields.domain_tags),
      parsedFields.evidence_refs === undefined ? null : JSON.stringify(parsedFields.evidence_refs),
      parsedFields.storage_tier ?? null,
      parsedFields.confidence ?? null,
      parsedFields.retention_state ?? null,
      parsedFields.last_used_at ?? null,
      parsedFields.last_hit_at ?? null,
      parsedFields.updated_at,
      objectId,
      parsedWorkspaceId
    );

    if (result.changes === 0) {
      throw new StorageError("NOT_FOUND", `Memory entry ${objectId} was not found.`);
    }

    const updated = await this.findById(objectId);

    if (updated === null || updated.workspace_id !== parsedWorkspaceId) {
      throw new StorageError("NOT_FOUND", `Memory entry ${objectId} was not found after update.`);
    }

    return updated;
  } catch (error) {
    if (error instanceof StorageError) {
      throw error;
    }

    throw new StorageError("QUERY_FAILED", `Failed to update memory entry ${objectId}.`, error);
  }
}

export function updateMemoryEntryTier(
  this: MemoryEntryUpdateWorkflowHost,
  input: MemoryEntryRepoTierUpdateInput
): Readonly<MemoryEntry> | null {
  const objectId = parseNonEmptyString(input.objectId, "object_id");
  const workspaceId = parseNonEmptyString(input.workspaceId, "workspace_id");
  const fromTier = parseStorageTier(input.fromTier);
  const toTier = parseStorageTier(input.toTier);
  const updatedAt = parseUpdatedAt(input.updatedAt);
  const expectedUpdatedAt = parseUpdatedAt(input.expectedUpdatedAt);
  const lastUsedAt = input.lastUsedAt === undefined ? undefined : parseUpdatedAt(input.lastUsedAt);
  const lastHitAt = input.lastHitAt === undefined ? undefined : parseUpdatedAt(input.lastHitAt);
  const activationBump = input.activationBump ?? 0;
  if (!Number.isFinite(activationBump) || activationBump < 0 || activationBump > 1) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate activation tier bump.");
  }

  try {
    const result = this.db.connection
      .prepare(
        `UPDATE memory_entries
         SET storage_tier = ?,
             activation_score = min(1.0, COALESCE(activation_score, 0.0) + ?),
             last_used_at = COALESCE(?, last_used_at),
             last_hit_at = COALESCE(?, last_hit_at),
             updated_at = ?
         WHERE object_id = ?
           AND workspace_id = ?
           AND storage_tier = ?
           AND updated_at = ?`
      )
      .run(
        toTier,
        activationBump,
        lastUsedAt ?? null,
        lastHitAt ?? null,
        updatedAt,
        objectId,
        workspaceId,
        fromTier,
        expectedUpdatedAt
      );

    if (result.changes === 0) {
      return null;
    }

    const row = this.findByIdStatement.get(objectId) as MemoryEntryRow | undefined;
    if (row === undefined) {
      throw new StorageError("NOT_FOUND", `Memory entry ${objectId} was not found after tier update.`);
    }
    return parseMemoryEntryRow(row);
  } catch (error) {
    if (error instanceof StorageError) {
      throw error;
    }

    throw new StorageError("QUERY_FAILED", `Failed to update memory entry tier for ${objectId}.`, error);
  }
}

export async function updateMemoryEntryDynamics(
  this: MemoryEntryUpdateWorkflowHost,
  objectId: string,
  fields: MemoryEntryRepoDynamicsUpdateFields,
  updatedAt: string
): Promise<Readonly<MemoryEntry>> {
  const parsedFields = parseDynamicsUpdateFields(fields);
  const parsedUpdatedAt = parseUpdatedAt(updatedAt);

  // invariant: dynamic SET preserves undefined-vs-null semantics for nullable fields.
  const setClauses: string[] = [
    "activation_score = ?",
    "retention_score = ?",
    "manifestation_state = ?"
  ];
  const params: Array<string | number | null> = [
    parsedFields.activation_score,
    parsedFields.retention_score,
    parsedFields.manifestation_state as string
  ];

  const optionalFields: Array<readonly [string, string | number | null | undefined]> = [
    ["retention_state", parsedFields.retention_state as string | null | undefined],
    ["last_used_at", parsedFields.last_used_at],
    ["last_hit_at", parsedFields.last_hit_at],
    ["reinforcement_count", parsedFields.reinforcement_count],
    ["contradiction_count", parsedFields.contradiction_count],
    ["superseded_by", parsedFields.superseded_by]
  ];

  for (const [column, value] of optionalFields) {
    if (value !== undefined) {
      setClauses.push(`${column} = ?`);
      params.push(value ?? null);
    }
  }

  setClauses.push("updated_at = ?");
  params.push(parsedUpdatedAt);
  params.push(objectId);

  try {
    const result = this.db.connection
      .prepare(`UPDATE memory_entries SET ${setClauses.join(", ")} WHERE object_id = ?`)
      .run(...params);

    if (result.changes === 0) {
      throw new StorageError("NOT_FOUND", `Memory entry ${objectId} was not found.`);
    }

    const updated = await this.findById(objectId);

    if (updated === null) {
      throw new StorageError("NOT_FOUND", `Memory entry ${objectId} was not found after update.`);
    }

    return updated;
  } catch (error) {
    if (error instanceof StorageError) {
      throw error;
    }

    throw new StorageError(
      "QUERY_FAILED",
      `Failed to update dynamics for memory entry ${objectId}.`,
      error
    );
  }
}
