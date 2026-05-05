import type { StorageDatabase } from "../db.js";
import { StorageError } from "../errors.js";

interface ConfigRow {
  readonly value: string;
}

export interface ConfigRepo {
  get<T>(key: string): Promise<T | null>;
  /** Sync sibling for atomic publish + mutation (#BL-022). */
  getSync<T>(key: string): T | null;
  set<T>(key: string, value: T): Promise<void>;
  /** Sync sibling for atomic publish + mutation (#BL-022). */
  setSync<T>(key: string, value: T): void;
  patch<T extends Record<string, unknown>>(key: string, partial: Partial<T>, defaults: T): Promise<T>;
  /** Sync sibling for atomic publish + mutation (#BL-022). */
  patchSync<T extends Record<string, unknown>>(key: string, partial: Partial<T>, defaults: T): T;
}

export class SqliteConfigRepo implements ConfigRepo {
  private readonly getStatement;
  private readonly upsertStatement;

  public constructor(private readonly db: StorageDatabase) {
    this.getStatement = db.connection.prepare(`
      SELECT value
      FROM app_config
      WHERE key = ?
      LIMIT 1
    `);

    this.upsertStatement = db.connection.prepare(`
      INSERT INTO app_config (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `);
  }

  public async get<T>(key: string): Promise<T | null> {
    return this.getSync<T>(key);
  }

  /** Synchronous variant for atomic publish + mutation (#BL-022). */
  public getSync<T>(key: string): T | null {
    try {
      const row = this.getStatement.get(key) as ConfigRow | undefined;

      if (row === undefined) {
        return null;
      }

      return JSON.parse(row.value) as T;
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to load config for key ${key}.`, error);
    }
  }

  public async set<T>(key: string, value: T): Promise<void> {
    this.setSync(key, value);
  }

  /** Synchronous variant for atomic publish + mutation (#BL-022). */
  public setSync<T>(key: string, value: T): void {
    try {
      this.upsertStatement.run(key, JSON.stringify(value), new Date().toISOString());
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to save config for key ${key}.`, error);
    }
  }

  public async patch<T extends Record<string, unknown>>(key: string, partial: Partial<T>, defaults: T): Promise<T> {
    return this.patchSync(key, partial, defaults);
  }

  /** Synchronous variant for atomic publish + mutation (#BL-022). */
  public patchSync<T extends Record<string, unknown>>(key: string, partial: Partial<T>, defaults: T): T {
    const current = this.getSync<T>(key) ?? defaults;
    const next = {
      ...current,
      ...partial
    } as T;
    this.setSync(key, next);
    return next;
  }
}
