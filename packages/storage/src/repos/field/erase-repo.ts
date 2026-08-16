import type { FieldContractSha256 } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { parseOptionalRow } from "../shared/parse-row.js";
import {
  fieldEraseBarrierParser,
  insertIdempotent,
  persistFieldTransaction
} from "./mappers.js";
import type { FieldEraseBarrierRepo, FieldEraseBarrierRow } from "./ports.js";

export class SqliteFieldEraseBarrierRepo implements FieldEraseBarrierRepo {
  private readonly insertStatement;
  private readonly selectStatement;
  private readonly clearRecordBody;
  private readonly clearFactorPayload;

  public constructor(
    private readonly database: StorageDatabase,
    _sha256: FieldContractSha256
  ) {
    this.insertStatement = database.connection.prepare(`
      INSERT INTO projection_erase_barriers (
        barrier_id, workspace_id, generation_id, subject_kind, subject_id, erased_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, barrier_id) DO NOTHING
    `);
    this.selectStatement = database.connection.prepare(`
      SELECT barrier_id, workspace_id, generation_id, subject_kind, subject_id, erased_at
      FROM projection_erase_barriers
      WHERE workspace_id = ? AND barrier_id = ? LIMIT 1
    `);
    this.clearRecordBody = database.connection.prepare(`
      UPDATE source_records SET source_body = NULL
      WHERE workspace_id = ? AND record_id = ?
    `);
    this.clearFactorPayload = database.connection.prepare(`
      UPDATE factor_descriptors SET canonical_payload = NULL
      WHERE workspace_id = ? AND factor_id = ?
    `);
  }

  public apply(row: FieldEraseBarrierRow): FieldEraseBarrierRow {
    return persistFieldTransaction(this.database, () => {
      const stored = insertIdempotent(
        () => this.insertStatement.run(
          row.barrier_id, row.workspace_id, row.generation_id,
          row.subject_kind, row.subject_id, row.erased_at
        ),
        () => this.findById(row.workspace_id, row.barrier_id),
        (existing) => sameBarrier(existing, row),
        "erase barrier"
      );
      this.clearSubject(stored);
      return stored;
    }, "erase barrier");
  }

  public findById(workspaceId: string, barrierId: string): FieldEraseBarrierRow | null {
    return parseOptionalRow(
      this.selectStatement.get(workspaceId, barrierId),
      fieldEraseBarrierParser,
      "erase barrier"
    );
  }

  private clearSubject(row: FieldEraseBarrierRow): void {
    if (row.subject_kind === "source_record") {
      this.clearRecordBody.run(row.workspace_id, row.subject_id);
    }
    if (row.subject_kind === "factor") {
      this.clearFactorPayload.run(row.workspace_id, row.subject_id);
    }
  }
}

function sameBarrier(existing: FieldEraseBarrierRow, incoming: FieldEraseBarrierRow): boolean {
  return existing.generation_id === incoming.generation_id &&
    existing.subject_kind === incoming.subject_kind &&
    existing.subject_id === incoming.subject_id;
}
