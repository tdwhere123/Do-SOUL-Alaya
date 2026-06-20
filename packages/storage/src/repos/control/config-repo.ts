import type { StorageDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";

export interface ConfigValueParser<T> {
  parse(value: unknown): T;
}

interface ConfigRow {
  readonly value: string;
}

export interface ConfigRepo {
  getParsed<T>(key: string, parser: ConfigValueParser<T>): T | null;
  setParsed<T>(key: string, value: T, parser: ConfigValueParser<T>): T;
  patchParsed<T extends Record<string, unknown>>(
    key: string,
    partial: Partial<T>,
    defaults: T,
    parser: ConfigValueParser<T>
  ): T;
}

export class SqliteConfigRepo implements ConfigRepo {
  private readonly getStatement;
  private readonly upsertStatement;

  public constructor(db: StorageDatabase) {
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

  public getParsed<T>(key: string, parser: ConfigValueParser<T>): T | null {
    try {
      const raw = this.getRaw(key);
      return raw === null ? null : parser.parse(raw);
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError("QUERY_FAILED", `Failed to load config for key ${key}.`, error);
    }
  }

  public setParsed<T>(key: string, value: T, parser: ConfigValueParser<T>): T {
    const parsedValue = parser.parse(value);
    this.setRaw(key, parsedValue);
    return parsedValue;
  }

  private setRaw<T>(key: string, value: T): void {
    try {
      this.upsertStatement.run(key, JSON.stringify(value), new Date().toISOString());
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to save config for key ${key}.`, error);
    }
  }

  public patchParsed<T extends Record<string, unknown>>(
    key: string,
    partial: Partial<T>,
    defaults: T,
    parser: ConfigValueParser<T>
  ): T {
    const current = this.getParsed(key, parser) ?? parser.parse(defaults);
    const next = parser.parse({
      ...current,
      ...partial
    });
    this.setParsed(key, next, parser);
    return next;
  }

  private getRaw(key: string): unknown | null {
    const row = this.getStatement.get(key) as ConfigRow | undefined;
    return row === undefined ? null : parseStoredConfigValue(row.value);
  }
}

function parseStoredConfigValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to parse stored config JSON.", error);
  }
}
