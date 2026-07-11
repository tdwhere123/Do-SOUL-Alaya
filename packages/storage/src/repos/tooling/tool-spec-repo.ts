import { ToolSpecSchema, type ToolSpec } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { toSqliteBoolean } from "../shared/sqlite-utils.js";

export interface ToolSpecRepo {
  insert(spec: ToolSpec): Promise<Readonly<ToolSpec>>;
  update(spec: ToolSpec): Promise<Readonly<ToolSpec>>;
  findById(toolId: string): Promise<Readonly<ToolSpec> | null>;
  list(): Promise<readonly Readonly<ToolSpec>[]>;
  delete(toolId: string): Promise<void>;
}

const TOOL_SPEC_SELECT_COLUMNS = `
        tool_id,
        category,
        description,
        scope_guard,
        read_only,
        destructive,
        concurrency_safe,
        interrupt_behavior,
        requires_confirmation,
        requires_evidence_reopen,
        rollback_support,
        fast_path_eligible
`;

interface ToolSpecRow {
  readonly tool_id: string;
  readonly category: string;
  readonly description: string;
  readonly scope_guard: string;
  readonly read_only: number;
  readonly destructive: number;
  readonly concurrency_safe: number;
  readonly interrupt_behavior: string;
  readonly requires_confirmation: number;
  readonly requires_evidence_reopen: number;
  readonly rollback_support: string;
  readonly fast_path_eligible: number;
}

export class SqliteToolSpecRepo implements ToolSpecRepo {
  private readonly insertStatement;
  private readonly updateStatement;
  private readonly findByIdStatement;
  private readonly listStatement;
  private readonly deleteStatement;

  public constructor(db: StorageDatabase) {
    this.insertStatement = db.connection.prepare(`
      INSERT INTO tool_specs (
        tool_id,
        category,
        description,
        scope_guard,
        read_only,
        destructive,
        concurrency_safe,
        interrupt_behavior,
        requires_confirmation,
        requires_evidence_reopen,
        rollback_support,
        fast_path_eligible
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.updateStatement = db.connection.prepare(`
      UPDATE tool_specs
      SET category = ?,
          description = ?,
          scope_guard = ?,
          read_only = ?,
          destructive = ?,
          concurrency_safe = ?,
          interrupt_behavior = ?,
          requires_confirmation = ?,
          requires_evidence_reopen = ?,
          rollback_support = ?,
          fast_path_eligible = ?
      WHERE tool_id = ?
    `);

    this.findByIdStatement = db.connection.prepare(`
      SELECT${TOOL_SPEC_SELECT_COLUMNS}
      FROM tool_specs
      WHERE tool_id = ?
      LIMIT 1
    `);

    this.listStatement = db.connection.prepare(`
      SELECT${TOOL_SPEC_SELECT_COLUMNS}
      FROM tool_specs
      ORDER BY tool_id ASC
    `);

    this.deleteStatement = db.connection.prepare(`
      DELETE FROM tool_specs
      WHERE tool_id = ?
    `);
  }

  public async insert(spec: ToolSpec): Promise<Readonly<ToolSpec>> {
    const parsedSpec = parseToolSpec(spec);

    try {
      this.insertStatement.run(
        parsedSpec.tool_id,
        parsedSpec.category,
        parsedSpec.description,
        parsedSpec.scope_guard,
        toSqliteBoolean(parsedSpec.read_only),
        toSqliteBoolean(parsedSpec.destructive),
        toSqliteBoolean(parsedSpec.concurrency_safe),
        parsedSpec.interrupt_behavior,
        toSqliteBoolean(parsedSpec.requires_confirmation),
        toSqliteBoolean(parsedSpec.requires_evidence_reopen),
        parsedSpec.rollback_support,
        toSqliteBoolean(parsedSpec.fast_path_eligible)
      );
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to insert tool spec ${parsedSpec.tool_id}.`, error);
    }

    const inserted = await this.findById(parsedSpec.tool_id);

    if (inserted === null) {
      throw new StorageError("NOT_FOUND", `Tool spec ${parsedSpec.tool_id} was not found after insert.`);
    }

    return inserted;
  }

  public async update(spec: ToolSpec): Promise<Readonly<ToolSpec>> {
    const parsedSpec = parseToolSpec(spec);
    const existing = await this.findById(parsedSpec.tool_id);

    if (existing === null) {
      throw new StorageError("NOT_FOUND", `Tool spec ${parsedSpec.tool_id} was not found.`);
    }

    try {
      const result = this.updateStatement.run(
        parsedSpec.category,
        parsedSpec.description,
        parsedSpec.scope_guard,
        toSqliteBoolean(parsedSpec.read_only),
        toSqliteBoolean(parsedSpec.destructive),
        toSqliteBoolean(parsedSpec.concurrency_safe),
        parsedSpec.interrupt_behavior,
        toSqliteBoolean(parsedSpec.requires_confirmation),
        toSqliteBoolean(parsedSpec.requires_evidence_reopen),
        parsedSpec.rollback_support,
        toSqliteBoolean(parsedSpec.fast_path_eligible),
        parsedSpec.tool_id
      );

      if (result.changes === 0) {
        throw new StorageError("NOT_FOUND", `Tool spec ${parsedSpec.tool_id} was not found.`);
      }

      const updated = await this.findById(parsedSpec.tool_id);

      if (updated === null) {
        throw new StorageError("NOT_FOUND", `Tool spec ${parsedSpec.tool_id} was not found after update.`);
      }

      return updated;
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError("QUERY_FAILED", `Failed to update tool spec ${parsedSpec.tool_id}.`, error);
    }
  }

  public async findById(toolId: string): Promise<Readonly<ToolSpec> | null> {
    try {
      const row = this.findByIdStatement.get(toolId) as ToolSpecRow | undefined;
      return row === undefined ? null : parseToolSpecRow(row);
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError("QUERY_FAILED", `Failed to load tool spec ${toolId}.`, error);
    }
  }

  public async list(): Promise<readonly Readonly<ToolSpec>[]> {
    try {
      const rows = this.listStatement.all() as ToolSpecRow[];
      return rows.map((row) => parseToolSpecRow(row));
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError("QUERY_FAILED", "Failed to list tool specs.", error);
    }
  }

  public async delete(toolId: string): Promise<void> {
    try {
      this.deleteStatement.run(toolId);
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to delete tool spec ${toolId}.`, error);
    }
  }
}

function parseToolSpec(value: ToolSpec): Readonly<ToolSpec> {
  try {
    return deepFreeze(ToolSpecSchema.parse(value));
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate tool spec.", error);
  }
}

function parseToolSpecRow(row: ToolSpecRow): Readonly<ToolSpec> {
  try {
    return deepFreeze(
      ToolSpecSchema.parse({
        tool_id: row.tool_id,
        category: row.category,
        description: row.description,
        scope_guard: row.scope_guard,
        read_only: row.read_only !== 0,
        destructive: row.destructive !== 0,
        concurrency_safe: row.concurrency_safe !== 0,
        interrupt_behavior: row.interrupt_behavior,
        requires_confirmation: row.requires_confirmation !== 0,
        requires_evidence_reopen: row.requires_evidence_reopen !== 0,
        rollback_support: row.rollback_support,
        fast_path_eligible: row.fast_path_eligible !== 0
      })
    );
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate tool spec row.", error);
  }
}

