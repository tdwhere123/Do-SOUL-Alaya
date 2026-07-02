import { type MemoryEntry } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";
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

interface ParsedTierUpdateRequest {
  readonly objectId: string;
  readonly workspaceId: string;
  readonly fromTier: string;
  readonly toTier: string;
  readonly updatedAt: string;
  readonly expectedUpdatedAt: string;
  readonly lastUsedAt: string | undefined;
  readonly lastHitAt: string | undefined;
  readonly activationBump: number;
}

interface DynamicUpdateParts {
  readonly setClauses: readonly string[];
  readonly params: readonly (string | number | null)[];
}

const PROJECTION_UPDATE_FIELDS = [
  "projection_schema_version",
  "event_time_start",
  "event_time_end",
  "valid_from",
  "valid_to",
  "time_precision",
  "time_source",
  "preference_subject",
  "preference_predicate",
  "preference_object",
  "preference_category",
  "preference_polarity",
  "facet_tags",
  "canonical_entities"
] as const satisfies readonly (keyof MemoryEntryRepoUpdateFields)[];

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
      ...buildProjectionUpdateParams(parsedFields),
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
      ...buildProjectionUpdateParams(parsedFields),
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

function buildProjectionUpdateParams(fields: MemoryEntryRepoUpdateFields): readonly unknown[] {
  return PROJECTION_UPDATE_FIELDS.flatMap((fieldName) => [
    hasOwn(fields, fieldName) ? 1 : 0,
    encodeProjectionUpdateValue(fieldName, fields[fieldName])
  ]);
}

function encodeProjectionUpdateValue(
  fieldName: (typeof PROJECTION_UPDATE_FIELDS)[number],
  value: MemoryEntryRepoUpdateFields[(typeof PROJECTION_UPDATE_FIELDS)[number]]
): unknown {
  if (fieldName === "facet_tags" || fieldName === "canonical_entities") {
    return value == null ? null : JSON.stringify(value);
  }
  return value ?? null;
}

function hasOwn<T extends object>(value: T, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function updateMemoryEntryTier(
  this: MemoryEntryUpdateWorkflowHost,
  input: MemoryEntryRepoTierUpdateInput
): Readonly<MemoryEntry> | null {
  const request = parseTierUpdateRequest(input);

  try {
    const result = runTierUpdate(this, request);

    if (result.changes === 0) {
      return null;
    }

    return loadUpdatedMemoryEntry(this, request.objectId, "tier update");
  } catch (error) {
    if (error instanceof StorageError) {
      throw error;
    }

    throw new StorageError("QUERY_FAILED", `Failed to update memory entry tier for ${request.objectId}.`, error);
  }
}

function parseTierUpdateRequest(input: MemoryEntryRepoTierUpdateInput): ParsedTierUpdateRequest {
  const activationBump = input.activationBump ?? 0;
  if (!Number.isFinite(activationBump) || activationBump < 0 || activationBump > 1) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate activation tier bump.");
  }
  return {
    objectId: parseNonEmptyString(input.objectId, "object_id"),
    workspaceId: parseNonEmptyString(input.workspaceId, "workspace_id"),
    fromTier: parseStorageTier(input.fromTier),
    toTier: parseStorageTier(input.toTier),
    updatedAt: parseUpdatedAt(input.updatedAt),
    expectedUpdatedAt: parseUpdatedAt(input.expectedUpdatedAt),
    lastUsedAt: input.lastUsedAt === undefined ? undefined : parseUpdatedAt(input.lastUsedAt),
    lastHitAt: input.lastHitAt === undefined ? undefined : parseUpdatedAt(input.lastHitAt),
    activationBump
  };
}

function runTierUpdate(
  host: MemoryEntryUpdateWorkflowHost,
  request: ParsedTierUpdateRequest
): { readonly changes: number } {
  return host.db.connection
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
      request.toTier,
      request.activationBump,
      request.lastUsedAt ?? null,
      request.lastHitAt ?? null,
      request.updatedAt,
      request.objectId,
      request.workspaceId,
      request.fromTier,
      request.expectedUpdatedAt
    );
}

export async function updateMemoryEntryDynamics(
  this: MemoryEntryUpdateWorkflowHost,
  objectId: string,
  fields: MemoryEntryRepoDynamicsUpdateFields,
  updatedAt: string
): Promise<Readonly<MemoryEntry>> {
  const parsedFields = parseDynamicsUpdateFields(fields);
  const parsedUpdatedAt = parseUpdatedAt(updatedAt);
  const dynamicUpdate = buildDynamicUpdateParts(parsedFields, parsedUpdatedAt, objectId);

  try {
    const result = this.db.connection
      .prepare(`UPDATE memory_entries SET ${dynamicUpdate.setClauses.join(", ")} WHERE object_id = ?`)
      .run(...dynamicUpdate.params);

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

function buildDynamicUpdateParts(
  parsedFields: ReturnType<typeof parseDynamicsUpdateFields>,
  updatedAt: string,
  objectId: string
): DynamicUpdateParts {
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
  appendOptionalDynamicFields(setClauses, params, parsedFields);
  setClauses.push("updated_at = ?");
  params.push(updatedAt, objectId);
  return { setClauses, params };
}

function appendOptionalDynamicFields(
  setClauses: string[],
  params: Array<string | number | null>,
  parsedFields: ReturnType<typeof parseDynamicsUpdateFields>
): void {
  for (const [column, value] of getOptionalDynamicFields(parsedFields)) {
    if (value !== undefined) {
      setClauses.push(`${column} = ?`);
      params.push(value ?? null);
    }
  }
}

function getOptionalDynamicFields(
  parsedFields: ReturnType<typeof parseDynamicsUpdateFields>
): readonly (readonly [string, string | number | null | undefined])[] {
  return [
    ["retention_state", parsedFields.retention_state as string | null | undefined],
    ["last_used_at", parsedFields.last_used_at],
    ["last_hit_at", parsedFields.last_hit_at],
    ["reinforcement_count", parsedFields.reinforcement_count],
    ["contradiction_count", parsedFields.contradiction_count],
    ["superseded_by", parsedFields.superseded_by]
  ];
}

function loadUpdatedMemoryEntry(
  host: MemoryEntryUpdateWorkflowHost,
  objectId: string,
  operation: string
): Readonly<MemoryEntry> {
  const row = host.findByIdStatement.get(objectId) as MemoryEntryRow | undefined;
  if (row === undefined) {
    throw new StorageError("NOT_FOUND", `Memory entry ${objectId} was not found after ${operation}.`);
  }
  return parseMemoryEntryRow(row);
}
