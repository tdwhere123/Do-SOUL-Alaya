import { StorageError } from "../../shared/errors.js";
import type { StorageDatabase } from "../../sqlite/db.js";
import { parseOptionalRow } from "../shared/parse-row.js";
import {
  fieldEraseBarrierParser,
  fieldProjectionGenerationParser,
  fieldProjectionPointerParser,
  insertIdempotent,
  persistFieldWrite
} from "./mappers.js";
import type {
  FieldEraseBarrierRepo,
  FieldEraseBarrierRow,
  FieldProjectionGenerationRepo,
  FieldProjectionGenerationRow,
  FieldProjectionGenerationStatus,
  FieldProjectionPointerRow
} from "./ports.js";

const GENERATION_SELECT = `
  SELECT generation_id, workspace_id, operator_manifest_digest, schema_version,
         input_event_frontier, governance_frontier, status
  FROM projection_generations
`;

export class SqliteFieldProjectionGenerationRepo implements FieldProjectionGenerationRepo {
  private readonly insertStatement;
  private readonly selectByIdStatement;
  private readonly selectPinnedStatement;
  private readonly updateStatusStatement;
  private readonly retireActiveStatement;
  private readonly upsertPointerStatement;
  private readonly selectPointerStatement;

  public constructor(database: StorageDatabase) {
    this.insertStatement = database.connection.prepare(`
      INSERT INTO projection_generations (
        generation_id, workspace_id, operator_manifest_digest, schema_version,
        input_event_frontier, governance_frontier, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(generation_id) DO NOTHING
    `);
    this.selectByIdStatement = database.connection.prepare(
      `${GENERATION_SELECT} WHERE generation_id = ? LIMIT 1`
    );
    this.selectPinnedStatement = database.connection.prepare(
      `${GENERATION_SELECT} WHERE workspace_id = ? AND generation_id = ? LIMIT 1`
    );
    this.updateStatusStatement = database.connection.prepare(`
      UPDATE projection_generations SET status = ? WHERE generation_id = ?
    `);
    this.retireActiveStatement = database.connection.prepare(`
      UPDATE projection_generations SET status = 'retired'
      WHERE workspace_id = ? AND status = 'active'
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
  }

  public insert(row: FieldProjectionGenerationRow): FieldProjectionGenerationRow {
    rejectActiveStatus(row.status);
    return insertIdempotent(
      () => this.insertStatement.run(
        row.generation_id, row.workspace_id, row.operator_manifest_digest,
        row.schema_version, row.input_event_frontier, row.governance_frontier, row.status
      ),
      () => this.readPinned(row.workspace_id, row.generation_id),
      (existing) => sameGeneration(existing, row),
      "projection generation"
    );
  }

  public persistStatus(
    generationId: string,
    status: FieldProjectionGenerationStatus
  ): FieldProjectionGenerationRow {
    rejectActiveStatus(status);
    return persistFieldWrite(() => {
      this.updateStatusStatement.run(status, generationId);
      const row = this.findById(generationId);
      if (row === null) {
        throw new StorageError("NOT_FOUND", "projection generation is missing");
      }
      return row;
    }, "projection generation status");
  }

  public activatePointer(pointer: FieldProjectionPointerRow): FieldProjectionPointerRow {
    return persistFieldWrite(() => {
      if (this.readPinned(pointer.workspace_id, pointer.active_generation_id) === null) {
        throw new StorageError("NOT_FOUND", "projection generation is missing");
      }
      this.retireActiveStatement.run(pointer.workspace_id);
      this.updateStatusStatement.run("active", pointer.active_generation_id);
      this.upsertPointerStatement.run(
        pointer.workspace_id, pointer.active_generation_id, pointer.activated_at
      );
      return parseOptionalRow(
        this.selectPointerStatement.get(pointer.workspace_id),
        fieldProjectionPointerParser,
        "projection generation pointer"
      ) ?? pointer;
    }, "projection generation pointer");
  }

  public readActive(workspaceId: string): FieldProjectionGenerationRow | null {
    const pointer = parseOptionalRow(
      this.selectPointerStatement.get(workspaceId),
      fieldProjectionPointerParser,
      "projection generation pointer"
    );
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

  private findById(generationId: string): FieldProjectionGenerationRow | null {
    return parseOptionalRow(
      this.selectByIdStatement.get(generationId),
      fieldProjectionGenerationParser,
      "projection generation"
    );
  }
}

export class SqliteFieldEraseBarrierRepo implements FieldEraseBarrierRepo {
  private readonly insertStatement;
  private readonly selectStatement;
  private readonly clearRecordBody;
  private readonly clearFactorPayload;

  public constructor(database: StorageDatabase) {
    this.insertStatement = database.connection.prepare(`
      INSERT INTO projection_erase_barriers (
        barrier_id, workspace_id, generation_id, subject_kind, subject_id, erased_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(barrier_id) DO NOTHING
    `);
    this.selectStatement = database.connection.prepare(`
      SELECT barrier_id, workspace_id, generation_id, subject_kind, subject_id, erased_at
      FROM projection_erase_barriers WHERE barrier_id = ? LIMIT 1
    `);
    this.clearRecordBody = database.connection.prepare(`
      UPDATE source_records SET source_body = NULL WHERE record_id = ?
    `);
    this.clearFactorPayload = database.connection.prepare(`
      UPDATE factor_descriptors SET canonical_payload = NULL WHERE factor_id = ?
    `);
  }

  public apply(row: FieldEraseBarrierRow): FieldEraseBarrierRow {
    return persistFieldWrite(() => {
      this.insertStatement.run(
        row.barrier_id, row.workspace_id, row.generation_id,
        row.subject_kind, row.subject_id, row.erased_at
      );
      this.clearSubject(row);
      const stored = this.findById(row.barrier_id);
      if (stored === null) {
        throw new StorageError("QUERY_FAILED", "Failed to persist erase barrier.");
      }
      return stored;
    }, "erase barrier");
  }

  public findById(barrierId: string): FieldEraseBarrierRow | null {
    return parseOptionalRow(
      this.selectStatement.get(barrierId),
      fieldEraseBarrierParser,
      "erase barrier"
    );
  }

  private clearSubject(row: FieldEraseBarrierRow): void {
    if (row.subject_kind === "source_record") this.clearRecordBody.run(row.subject_id);
    if (row.subject_kind === "factor") this.clearFactorPayload.run(row.subject_id);
  }
}

function rejectActiveStatus(status: FieldProjectionGenerationStatus): void {
  if (status === "active") {
    throw new StorageError("VALIDATION_FAILED", "generation activation requires a pointer swap");
  }
}

function sameGeneration(
  existing: FieldProjectionGenerationRow,
  incoming: FieldProjectionGenerationRow
): boolean {
  return existing.workspace_id === incoming.workspace_id &&
    existing.operator_manifest_digest === incoming.operator_manifest_digest &&
    existing.schema_version === incoming.schema_version &&
    existing.input_event_frontier === incoming.input_event_frontier &&
    existing.governance_frontier === incoming.governance_frontier &&
    existing.status === incoming.status;
}
