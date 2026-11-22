import {
  type DerivationJobStatus,
  type FieldContractSha256
} from "@do-soul/alaya-protocol";
import { StorageError } from "../../shared/errors.js";
import type { StorageDatabase } from "../../sqlite/db.js";
import { parseOptionalRow } from "../shared/parse-row.js";
import {
  canonicalizeEvidenceIdsJson,
  verifyPersistedJob
} from "./identity.js";
import {
  fieldDerivationJobParser,
  insertIdempotent,
  persistFieldWrite
} from "./mappers/mappers.js";
import type {
  FieldDerivationJobRepo,
  FieldDerivationJobRow
} from "./ports.js";

export class SqliteFieldDerivationJobRepo implements FieldDerivationJobRepo {
  private readonly insertStatement;
  private readonly selectStatement;
  private readonly updateStatusStatement;

  public constructor(
    database: StorageDatabase,
    private readonly sha256: FieldContractSha256
  ) {
    this.insertStatement = database.connection.prepare(`
      INSERT INTO derivation_jobs (
        job_id, workspace_id, purpose, operator_id, input_evidence_ids_json,
        status, disposition, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, job_id) DO NOTHING
    `);
    this.selectStatement = database.connection.prepare(`
      SELECT job_id, workspace_id, purpose, operator_id, input_evidence_ids_json,
             status, disposition, recorded_at
      FROM derivation_jobs WHERE workspace_id = ? AND job_id = ? LIMIT 1
    `);
    this.updateStatusStatement = database.connection.prepare(`
      UPDATE derivation_jobs SET status = ?
      WHERE workspace_id = ? AND job_id = ? AND status = ?
    `);
  }

  public insert(row: FieldDerivationJobRow): FieldDerivationJobRow {
    const canonical = {
      ...row,
      input_evidence_ids_json: canonicalizeEvidenceIdsJson(row.input_evidence_ids_json)
    };
    verifyPersistedJob(canonical, this.sha256);
    return insertIdempotent(
      () => this.insertStatement.run(
        canonical.job_id, canonical.workspace_id, canonical.purpose, canonical.operator_id,
        canonical.input_evidence_ids_json, canonical.status, canonical.disposition,
        canonical.recorded_at
      ),
      () => this.findById(canonical.workspace_id, canonical.job_id),
      (existing) => existing.purpose === canonical.purpose &&
        existing.operator_id === canonical.operator_id &&
        existing.input_evidence_ids_json === canonical.input_evidence_ids_json,
      "derivation job"
    );
  }

  public persistStatus(
    workspaceId: string,
    jobId: string,
    expected: DerivationJobStatus,
    next: DerivationJobStatus
  ): FieldDerivationJobRow {
    return persistFieldWrite(() => {
      const changed = this.updateStatusStatement.run(next, workspaceId, jobId, expected);
      if (changed.changes !== 1) {
        throw new StorageError("CONFLICT", "derivation job status transition failed");
      }
      const row = this.findById(workspaceId, jobId);
      if (row === null) {
        throw new StorageError("NOT_FOUND", "derivation job is missing");
      }
      return row;
    }, "derivation job status");
  }

  public findById(workspaceId: string, jobId: string): FieldDerivationJobRow | null {
    return parseOptionalRow(
      this.selectStatement.get(workspaceId, jobId),
      fieldDerivationJobParser,
      "derivation job"
    );
  }
}
