import type {
  FieldContractSha256,
  ProjectionGenerationStatus
} from "@do-soul/alaya-protocol";
import { StorageError } from "../../shared/errors.js";
import type { StorageDatabase } from "../../sqlite/db.js";
import { parseOptionalRow } from "../shared/parse-row.js";
import { verifyPersistedGeneration } from "./identity.js";
import {
  fieldProjectionGenerationParser,
  fieldProjectionPinParser,
  fieldProjectionPointerParser,
  insertIdempotent,
  persistFieldTransaction,
  persistFieldWrite
} from "./mappers.js";
import type {
  FieldProjectionGenerationRepo,
  FieldProjectionGenerationRow,
  FieldProjectionPinRow,
  FieldProjectionPointerRow
} from "./ports.js";

const GENERATION_SELECT = `
  SELECT generation_id, workspace_id, operator_manifest_digest, operator_versions_json,
         schema_version, input_event_frontier, governance_frontier, status, recorded_at
  FROM projection_generations
`;

export class SqliteFieldProjectionGenerationRepo implements FieldProjectionGenerationRepo {
  private readonly insertStatement;
  private readonly selectPinnedStatement;
  private readonly updateStatusStatement;
  private readonly retirePreviousStatement;
  private readonly upsertPointerStatement;
  private readonly selectPointerStatement;
  private readonly insertPinStatement;
  private readonly selectPinStatement;

  public constructor(
    private readonly database: StorageDatabase,
    private readonly sha256: FieldContractSha256
  ) {
    this.insertStatement = database.connection.prepare(`
      INSERT INTO projection_generations (
        generation_id, workspace_id, operator_manifest_digest, operator_versions_json,
        schema_version, input_event_frontier, governance_frontier, status, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, generation_id) DO NOTHING
    `);
    this.selectPinnedStatement = database.connection.prepare(
      `${GENERATION_SELECT} WHERE workspace_id = ? AND generation_id = ? LIMIT 1`
    );
    this.updateStatusStatement = database.connection.prepare(`
      UPDATE projection_generations SET status = ?
      WHERE workspace_id = ? AND generation_id = ?
    `);
    this.retirePreviousStatement = database.connection.prepare(`
      UPDATE projection_generations SET status = 'retired'
      WHERE workspace_id = ? AND status = 'active' AND generation_id != ?
    `);
    this.upsertPointerStatement = database.connection.prepare(`
      INSERT INTO projection_generation_pointer (
        workspace_id, active_generation_id, activated_at
      ) VALUES (?, ?, ?)
      ON CONFLICT(workspace_id) DO UPDATE SET
        active_generation_id = excluded.active_generation_id,
        activated_at = excluded.activated_at
    `);
    this.selectPointerStatement = database.connection.prepare(`
      SELECT workspace_id, active_generation_id, activated_at
      FROM projection_generation_pointer WHERE workspace_id = ? LIMIT 1
    `);
    this.insertPinStatement = database.connection.prepare(`
      INSERT INTO projection_pins (workspace_id, generation_id, pinned_at)
      VALUES (?, ?, ?)
      ON CONFLICT(workspace_id, generation_id) DO NOTHING
    `);
    this.selectPinStatement = database.connection.prepare(`
      SELECT workspace_id, generation_id, pinned_at
      FROM projection_pins WHERE workspace_id = ? AND generation_id = ? LIMIT 1
    `);
  }

  public insert(row: FieldProjectionGenerationRow): FieldProjectionGenerationRow {
    rejectActiveStatus(row.status);
    verifyPersistedGeneration(row, this.sha256);
    return insertIdempotent(
      () => this.insertStatement.run(
        row.generation_id, row.workspace_id, row.operator_manifest_digest,
        row.operator_versions_json, row.schema_version, row.input_event_frontier,
        row.governance_frontier, row.status, row.recorded_at
      ),
      () => this.readPinned(row.workspace_id, row.generation_id),
      (existing) => sameGeneration(existing, row),
      "projection generation"
    );
  }

  public persistStatus(
    workspaceId: string,
    generationId: string,
    status: ProjectionGenerationStatus
  ): FieldProjectionGenerationRow {
    rejectActiveStatus(status);
    return persistFieldWrite(() => {
      const pointer = this.readPointer(workspaceId);
      if (pointer?.active_generation_id === generationId) {
        throw new StorageError("VALIDATION_FAILED", "pointed generation requires pointer swap");
      }
      this.updateStatusStatement.run(status, workspaceId, generationId);
      const row = this.readPinned(workspaceId, generationId);
      if (row === null) {
        throw new StorageError("NOT_FOUND", "projection generation is missing");
      }
      return row;
    }, "projection generation status");
  }

  public activatePointer(pointer: FieldProjectionPointerRow): FieldProjectionPointerRow {
    return persistFieldTransaction(this.database, () => {
      if (this.readPinned(pointer.workspace_id, pointer.active_generation_id) === null) {
        throw new StorageError("NOT_FOUND", "projection generation is missing");
      }
      this.upsertPointerStatement.run(
        pointer.workspace_id, pointer.active_generation_id, pointer.activated_at
      );
      this.retirePreviousStatement.run(pointer.workspace_id, pointer.active_generation_id);
      this.updateStatusStatement.run(
        "active", pointer.workspace_id, pointer.active_generation_id
      );
      return this.readPointer(pointer.workspace_id) ?? pointer;
    }, "projection generation pointer");
  }

  public pin(pin: FieldProjectionPinRow): FieldProjectionPinRow {
    if (this.readPinned(pin.workspace_id, pin.generation_id) === null) {
      throw new StorageError("NOT_FOUND", "projection generation is missing");
    }
    return insertIdempotent(
      () => this.insertPinStatement.run(pin.workspace_id, pin.generation_id, pin.pinned_at),
      () => parseOptionalRow(
        this.selectPinStatement.get(pin.workspace_id, pin.generation_id),
        fieldProjectionPinParser,
        "projection pin"
      ),
      (existing) => existing.generation_id === pin.generation_id,
      "projection pin"
    );
  }

  public readActive(workspaceId: string): FieldProjectionGenerationRow | null {
    const pointer = this.readPointer(workspaceId);
    return pointer === null
      ? null
      : this.readPinned(workspaceId, pointer.active_generation_id);
  }

  public readPinned(
    workspaceId: string,
    generationId: string
  ): FieldProjectionGenerationRow | null {
    return parseOptionalRow(
      this.selectPinnedStatement.get(workspaceId, generationId),
      fieldProjectionGenerationParser,
      "projection generation"
    );
  }

  public readByGenerationIds(
    workspaceId: string,
    generationIds: readonly string[]
  ): readonly FieldProjectionGenerationRow[] {
    const unique = [...new Set(generationIds)];
    if (unique.length !== 1) {
      throw new StorageError("VALIDATION_FAILED", "mixed generation read is forbidden");
    }
    const row = this.readPinned(workspaceId, unique[0]!);
    return Object.freeze(row === null ? [] : [row]);
  }

  private readPointer(workspaceId: string): FieldProjectionPointerRow | null {
    return parseOptionalRow(
      this.selectPointerStatement.get(workspaceId),
      fieldProjectionPointerParser,
      "projection generation pointer"
    );
  }
}

function rejectActiveStatus(status: ProjectionGenerationStatus): void {
  if (status === "active") {
    throw new StorageError("VALIDATION_FAILED", "generation activation requires a pointer swap");
  }
}

function sameGeneration(
  existing: FieldProjectionGenerationRow,
  incoming: FieldProjectionGenerationRow
): boolean {
  return existing.operator_manifest_digest === incoming.operator_manifest_digest &&
    existing.operator_versions_json === incoming.operator_versions_json &&
    existing.schema_version === incoming.schema_version &&
    existing.input_event_frontier === incoming.input_event_frontier &&
    existing.governance_frontier === incoming.governance_frontier;
}
