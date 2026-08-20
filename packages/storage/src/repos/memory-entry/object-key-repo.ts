import {
  MemoryObjectKeySchema,
  type MemoryObjectKey
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";

export interface MemoryObjectKeyRepo {
  replaceOwnerKeys(
    workspaceId: string,
    ownerId: string,
    keys: readonly Readonly<MemoryObjectKey>[]
  ): void;
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
    keys: readonly Readonly<MemoryObjectKey>[]
  ): void {
    const parsed = keys.map((key) => parseOwnerKey(workspaceId, ownerId, key));
    this.db.connection.transaction(() => {
      this.db.connection.prepare(`
        DELETE FROM memory_object_keys WHERE workspace_id = ? AND owner_id = ?
      `).run(workspaceId, ownerId);
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
    })();
  }

  public listByOwner(
    workspaceId: string,
    ownerId: string
  ): readonly Readonly<MemoryObjectKey>[] {
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
  }

  public summarize(): Readonly<{ readonly object_count: number; readonly key_count: number }> {
    const row = this.db.connection.prepare(`
      SELECT COUNT(*) AS key_count, COUNT(DISTINCT owner_id) AS object_count
      FROM memory_object_keys
    `).get() as Readonly<{ readonly key_count: number; readonly object_count: number }>;
    return Object.freeze({
      object_count: row.object_count,
      key_count: row.key_count
    });
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
