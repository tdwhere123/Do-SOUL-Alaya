import type {
  FieldContractSha256,
  ProjectionGenerationPort,
  ProjectionGenerationStatus
} from "@do-soul/alaya-protocol";
import { StorageError } from "../../shared/errors.js";
import type { StorageDatabase } from "../../sqlite/db.js";
import { parseOptionalRow } from "../shared/parse-row.js";
import { generationFromRow, generationToRow } from "./field-receipts.js";
import { verifyPersistedGeneration } from "./identity.js";
import {
  fieldProjectionGenerationParser,
  fieldProjectionArtifactsParser,
  fieldProjectionPinParser,
  fieldProjectionPointerParser,
  insertIdempotent,
  persistFieldTransaction,
  persistFieldWrite
} from "./mappers.js";
import type {
  FieldProjectionGenerationRepo,
  FieldProjectionArtifactsRow,
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
  private readonly renewPinStatement;
  private readonly releasePinStatement;
  private readonly selectCollectableRetiredStatement;
  private readonly deleteCollectableRetiredStatement;
  private readonly insertArtifactsStatement;
  private readonly selectArtifactsStatement;

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
      INSERT INTO projection_pins (
        workspace_id, generation_id, reader_id, pinned_at, expires_at, released_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, generation_id, reader_id) DO NOTHING
    `);
    this.selectPinStatement = database.connection.prepare(`
      SELECT workspace_id, generation_id, reader_id, pinned_at, expires_at, released_at
      FROM projection_pins
      WHERE workspace_id = ? AND generation_id = ? AND reader_id = ? LIMIT 1
    `);
    this.releasePinStatement = database.connection.prepare(`
      UPDATE projection_pins SET released_at = ?
      WHERE workspace_id = ? AND generation_id = ? AND reader_id = ?
        AND released_at IS NULL
    `);
    this.renewPinStatement = database.connection.prepare(`
      UPDATE projection_pins SET expires_at = ?
      WHERE workspace_id = ? AND generation_id = ? AND reader_id = ?
        AND released_at IS NULL AND expires_at > ? AND expires_at < ?
    `);
    this.selectCollectableRetiredStatement = database.connection.prepare(`
      SELECT generation_id FROM projection_generations AS generation
      WHERE generation.workspace_id = ? AND generation.status = 'retired'
        AND NOT EXISTS (
          SELECT 1 FROM projection_generation_pointer AS pointer
          WHERE pointer.workspace_id = generation.workspace_id
            AND pointer.active_generation_id = generation.generation_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM projection_pins AS pin
          WHERE pin.workspace_id = generation.workspace_id
            AND pin.generation_id = generation.generation_id
            AND pin.released_at IS NULL AND pin.expires_at > ?
        )
      ORDER BY generation_id
    `);
    this.deleteCollectableRetiredStatement = database.connection.prepare(`
      DELETE FROM projection_generations
      WHERE workspace_id = ? AND generation_id = ? AND status = 'retired'
        AND NOT EXISTS (
          SELECT 1 FROM projection_generation_pointer
          WHERE workspace_id = ? AND active_generation_id = ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM projection_pins
          WHERE workspace_id = ? AND generation_id = ?
            AND released_at IS NULL AND expires_at > ?
        )
    `);
    this.insertArtifactsStatement = database.connection.prepare(`
      INSERT INTO projection_generation_artifacts (
        workspace_id, generation_id, artifact_digest, artifacts_json, recorded_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, generation_id) DO NOTHING
    `);
    this.selectArtifactsStatement = database.connection.prepare(`
      SELECT workspace_id, generation_id, artifact_digest, artifacts_json, recorded_at
      FROM projection_generation_artifacts
      WHERE workspace_id = ? AND generation_id = ? LIMIT 1
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
      const target = this.readPinned(pointer.workspace_id, pointer.active_generation_id);
      if (target === null) {
        throw new StorageError("NOT_FOUND", "projection generation is missing");
      }
      if (target.status !== "verified" && target.status !== "active") {
        throw new StorageError(
          "VALIDATION_FAILED",
          "projection generation must be verified before activation"
        );
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
      () => this.insertPinStatement.run(
        pin.workspace_id,
        pin.generation_id,
        pin.reader_id,
        pin.pinned_at,
        pin.expires_at,
        pin.released_at
      ),
      () => parseOptionalRow(
        this.selectPinStatement.get(pin.workspace_id, pin.generation_id, pin.reader_id),
        fieldProjectionPinParser,
        "projection pin"
      ),
      (existing) => samePin(existing, pin),
      "projection pin"
    );
  }

  public releasePin(input: Readonly<{
    readonly workspace_id: string;
    readonly generation_id: string;
    readonly reader_id: string;
    readonly released_at: string;
  }>): FieldProjectionPinRow {
    return persistFieldTransaction(this.database, () => {
      this.releasePinStatement.run(
        input.released_at,
        input.workspace_id,
        input.generation_id,
        input.reader_id
      );
      const row = this.readPin(input.workspace_id, input.generation_id, input.reader_id);
      if (row === null) throw new StorageError("NOT_FOUND", "projection pin is missing");
      return row;
    }, "projection pin release");
  }

  public renewPin(input: Readonly<{
    readonly workspace_id: string;
    readonly generation_id: string;
    readonly reader_id: string;
    readonly renewed_at: string;
    readonly expires_at: string;
  }>): FieldProjectionPinRow {
    return persistFieldTransaction(this.database, () => {
      this.renewPinStatement.run(
        input.expires_at,
        input.workspace_id,
        input.generation_id,
        input.reader_id,
        input.renewed_at,
        input.expires_at
      );
      const row = this.readPin(input.workspace_id, input.generation_id, input.reader_id);
      if (row === null || row.released_at !== null || row.expires_at <= input.renewed_at) {
        throw new StorageError("NOT_FOUND", "projection pin is missing, released, or expired");
      }
      return row;
    }, "projection pin renewal");
  }

  public readPin(
    workspaceId: string,
    generationId: string,
    readerId: string
  ): FieldProjectionPinRow | null {
    return parseOptionalRow(
      this.selectPinStatement.get(workspaceId, generationId, readerId),
      fieldProjectionPinParser,
      "projection pin"
    );
  }

  public collectRetired(workspaceId: string, asOf: string): readonly string[] {
    return persistFieldTransaction(this.database, () => {
      const candidates = this.selectCollectableRetiredStatement.all(
        workspaceId,
        asOf
      ) as readonly Readonly<{ generation_id: string }>[];
      const collected: string[] = [];
      for (const candidate of candidates) {
        const result = this.deleteCollectableRetiredStatement.run(
          workspaceId,
          candidate.generation_id,
          workspaceId,
          candidate.generation_id,
          workspaceId,
          candidate.generation_id,
          asOf
        );
        if (result.changes === 1) collected.push(candidate.generation_id);
      }
      return Object.freeze(collected);
    }, "retired projection generation collection");
  }

  public putArtifacts(row: FieldProjectionArtifactsRow): FieldProjectionArtifactsRow {
    if (this.readPinned(row.workspace_id, row.generation_id) === null) {
      throw new StorageError("NOT_FOUND", "projection generation is missing");
    }
    return insertIdempotent(
      () => this.insertArtifactsStatement.run(
        row.workspace_id,
        row.generation_id,
        row.artifact_digest,
        row.artifacts_json,
        row.recorded_at
      ),
      () => this.readArtifacts(row.workspace_id, row.generation_id),
      (existing) => existing.artifact_digest === row.artifact_digest &&
        existing.artifacts_json === row.artifacts_json,
      "projection generation artifacts"
    );
  }

  public readArtifacts(
    workspaceId: string,
    generationId: string
  ): FieldProjectionArtifactsRow | null {
    return parseOptionalRow(
      this.selectArtifactsStatement.get(workspaceId, generationId),
      fieldProjectionArtifactsParser,
      "projection generation artifacts"
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

  public asGenerationPort(): ProjectionGenerationPort {
    return {
      snapshot: (input) => generationFromRow(this.insert(generationToRow(input))),
      verify: (input) => generationFromRow(
        this.persistStatus(input.workspace_id, input.generation_id, "verified")
      ),
      activatePointer: (input) => this.activatePointer(input),
      pin: (input) => this.pin(input),
      release: (input) => this.releasePin(input)
    };
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

function samePin(existing: FieldProjectionPinRow, incoming: FieldProjectionPinRow): boolean {
  return existing.generation_id === incoming.generation_id &&
    existing.reader_id === incoming.reader_id &&
    existing.pinned_at === incoming.pinned_at &&
    existing.expires_at === incoming.expires_at;
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
