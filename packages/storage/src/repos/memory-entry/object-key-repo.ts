import {
  MemoryObjectKeySchema,
  canonicalJson,
  type MemoryEntry,
  type MemoryObjectKey
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";
import { requirePrivacyKindAvailable, requirePrivacyObjectAvailable } from "../field/privacy-availability.js";

export interface MemoryObjectKeyRepo {
  replaceOwnerKeys(
    workspaceId: string,
    ownerId: string,
    keys: readonly Readonly<MemoryObjectKey>[],
    expectedOwner: Pick<MemoryEntry, "content" | "evidence_refs">
  ): boolean;
  listByOwner(workspaceId: string, ownerId: string): readonly Readonly<MemoryObjectKey>[];
  summarize(): Readonly<{ readonly object_count: number; readonly key_count: number }>;
}

interface MemoryObjectKeyRow {
  readonly workspace_id: string;
  readonly owner_id: string;
  readonly key_id: string;
  readonly key_type: MemoryObjectKey["key_type"];
  readonly surface: string;
  readonly normalized_surface: string;
  readonly language: MemoryObjectKey["language"];
  readonly source_kind: MemoryObjectKey["source_kind"];
  readonly source_ref: string;
}

export class SqliteMemoryObjectKeyRepo implements MemoryObjectKeyRepo {
  public constructor(private readonly db: StorageDatabase) {}

  public replaceOwnerKeys(
    workspaceId: string,
    ownerId: string,
    keys: readonly Readonly<MemoryObjectKey>[],
    expectedOwner: Pick<MemoryEntry, "content" | "evidence_refs">
  ): boolean {
    if (expectedOwner === undefined) throw new StorageError("VALIDATION_FAILED", "memory key replacement requires its owner snapshot");
    const parsed = keys.map((key) => parseOwnerKey(workspaceId, ownerId, key));
    return this.db.connection.transaction(() => {
      requirePrivacyObjectAvailable(this.db, workspaceId, "memory_entry", ownerId);
      const owner = this.db.connection.prepare(`SELECT content, evidence_refs, lifecycle_state, retention_state
        FROM memory_entries WHERE workspace_id = ? AND object_id = ?`).get(workspaceId, ownerId) as
        { content: string; evidence_refs: string; lifecycle_state: string; retention_state: string | null } | undefined;
      if (owner === undefined || owner.content !== expectedOwner.content ||
        canonicalJson(JSON.parse(owner.evidence_refs)) !== canonicalJson(expectedOwner.evidence_refs)) return false;
      this.db.connection.prepare(`
        DELETE FROM memory_object_keys WHERE workspace_id = ? AND owner_id = ?
      `).run(workspaceId, ownerId);
      if (owner.lifecycle_state === "tombstone" || owner.retention_state === "tombstoned") return false;
      const insert = this.db.connection.prepare(`
        INSERT INTO memory_object_keys (
          workspace_id, owner_id, key_id, key_type, surface, normalized_surface,
          language, source_kind, source_ref
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const key of parsed) {
        insert.run(
          key.workspace_id,
          key.owner_id,
          key.key_id,
          key.key_type,
          key.surface,
          key.normalized_surface,
          key.language,
          key.source_kind,
          key.source_ref
        );
      }
      return true;
    })();
  }

  public listByOwner(
    workspaceId: string,
    ownerId: string
  ): readonly Readonly<MemoryObjectKey>[] {
    return this.db.connection.transaction(() => {
      requirePrivacyObjectAvailable(this.db, workspaceId, "memory_entry", ownerId);
      const rows = this.db.connection.prepare(`
      SELECT workspace_id, owner_id, key_id, key_type, surface, normalized_surface,
             language, source_kind, source_ref
      FROM memory_object_keys
      WHERE workspace_id = ? AND owner_id = ?
      ORDER BY key_id ASC
    `).all(workspaceId, ownerId) as readonly MemoryObjectKeyRow[];
      return Object.freeze(rows.map((row) => MemoryObjectKeySchema.parse({
        schema_version: 1,
        ...row
      })));
    })();
  }

  public summarize(): Readonly<{ readonly object_count: number; readonly key_count: number }> {
    return this.db.connection.transaction(() => {
      requirePrivacyKindAvailable(this.db, "memory_entry");
      const row = this.db.connection.prepare(`
      SELECT COUNT(*) AS key_count, COUNT(DISTINCT owner_id) AS object_count
      FROM memory_object_keys
    `).get() as Readonly<{ readonly key_count: number; readonly object_count: number }>;
      return Object.freeze({
        object_count: row.object_count,
        key_count: row.key_count
      });
    })();
  }
}

function parseOwnerKey(
  workspaceId: string,
  ownerId: string,
  key: Readonly<MemoryObjectKey>
): Readonly<MemoryObjectKey> {
  const parsed = MemoryObjectKeySchema.parse(key);
  if (parsed.workspace_id !== workspaceId || parsed.owner_id !== ownerId) {
    throw new StorageError(
      "VALIDATION_FAILED",
      "memory object key owner or workspace does not match the replace target"
    );
  }
  return parsed;
}
