import {
  sameFactorDescriptorFields,
  type DerivationJobStatus,
  type FieldContractSha256
} from "@do-soul/alaya-protocol";
import { StorageError } from "../../shared/errors.js";
import type { StorageDatabase } from "../../sqlite/db.js";
import { parseOptionalRow, parseRows } from "../shared/parse-row.js";
import {
  assertSubjectNotErased,
  canonicalizeEvidenceIdsJson,
  verifyPersistedFactor,
  verifyPersistedIncidence,
  verifyPersistedJob
} from "./identity.js";
import {
  fieldDerivationJobParser,
  fieldFactorDescriptorParser,
  fieldFactorIncidenceParser,
  insertIdempotent,
  persistFieldWrite
} from "./mappers.js";
import type {
  FieldDerivationJobRepo,
  FieldDerivationJobRow,
  FieldFactorDescriptorRow,
  FieldFactorIncidenceRow,
  FieldFactorRepo
} from "./ports.js";

const DESCRIPTOR_SELECT = `
  SELECT factor_id, workspace_id, family, canonical_payload, operator_id, recorded_at
  FROM factor_descriptors
`;

const INCIDENCE_SELECT = `
  SELECT incidence_id, span_id, factor_id, scope, operator_id, workspace_id, recorded_at
  FROM factor_incidences
`;

export class SqliteFieldFactorRepo implements FieldFactorRepo {
  private readonly insertDescriptorStatement;
  private readonly selectDescriptorStatement;
  private readonly listDescriptorStatement;
  private readonly insertIncidenceStatement;
  private readonly selectIncidenceStatement;
  private readonly listIncidenceStatement;

  public constructor(
    private readonly database: StorageDatabase,
    private readonly sha256: FieldContractSha256
  ) {
    this.insertDescriptorStatement = database.connection.prepare(`
      INSERT INTO factor_descriptors (
        factor_id, workspace_id, family, canonical_payload, operator_id, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, factor_id) DO NOTHING
    `);
    this.selectDescriptorStatement = database.connection.prepare(
      `${DESCRIPTOR_SELECT} WHERE workspace_id = ? AND factor_id = ? LIMIT 1`
    );
    this.listDescriptorStatement = database.connection.prepare(
      `${DESCRIPTOR_SELECT} WHERE workspace_id = ? ORDER BY factor_id`
    );
    this.insertIncidenceStatement = database.connection.prepare(`
      INSERT INTO factor_incidences (
        incidence_id, span_id, factor_id, scope, operator_id, workspace_id, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, incidence_id) DO NOTHING
    `);
    this.selectIncidenceStatement = database.connection.prepare(
      `${INCIDENCE_SELECT} WHERE workspace_id = ? AND incidence_id = ? LIMIT 1`
    );
    this.listIncidenceStatement = database.connection.prepare(
      `${INCIDENCE_SELECT} WHERE workspace_id = ? ORDER BY incidence_id`
    );
  }

  public insertDescriptor(row: FieldFactorDescriptorRow): FieldFactorDescriptorRow {
    verifyPersistedFactor(row, this.sha256);
    if (this.findDescriptor(row.workspace_id, row.factor_id) === null) {
      assertSubjectNotErased(this.database, row.workspace_id, "factor", row.factor_id);
    }
    return insertIdempotent(
      () => this.insertDescriptorStatement.run(
        row.factor_id, row.workspace_id, row.family, row.canonical_payload,
        row.operator_id, row.recorded_at
      ),
      () => this.findDescriptor(row.workspace_id, row.factor_id),
      (existing) => sameDescriptor(existing, row),
      "factor descriptor"
    );
  }

  public insertIncidence(row: FieldFactorIncidenceRow): FieldFactorIncidenceRow {
    verifyPersistedIncidence(row, this.sha256);
    return insertIdempotent(
      () => this.insertIncidenceStatement.run(
        row.incidence_id, row.span_id, row.factor_id, row.scope,
        row.operator_id, row.workspace_id, row.recorded_at
      ),
      () => this.findIncidence(row.workspace_id, row.incidence_id),
      (existing) => existing.span_id === row.span_id &&
        existing.factor_id === row.factor_id &&
        existing.scope === row.scope &&
        existing.operator_id === row.operator_id,
      "factor incidence"
    );
  }

  public findDescriptor(workspaceId: string, factorId: string): FieldFactorDescriptorRow | null {
    return parseOptionalRow(
      this.selectDescriptorStatement.get(workspaceId, factorId),
      fieldFactorDescriptorParser,
      "factor descriptor"
    );
  }

  public findIncidence(workspaceId: string, incidenceId: string): FieldFactorIncidenceRow | null {
    return parseOptionalRow(
      this.selectIncidenceStatement.get(workspaceId, incidenceId),
      fieldFactorIncidenceParser,
      "factor incidence"
    );
  }

  public listDescriptors(workspaceId: string): readonly FieldFactorDescriptorRow[] {
    return parseRows(
      this.listDescriptorStatement.all(workspaceId),
      fieldFactorDescriptorParser,
      "factor descriptor"
    );
  }

  public listIncidences(workspaceId: string): readonly FieldFactorIncidenceRow[] {
    return parseRows(
      this.listIncidenceStatement.all(workspaceId),
      fieldFactorIncidenceParser,
      "factor incidence"
    );
  }
}

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

function sameDescriptor(
  existing: FieldFactorDescriptorRow,
  incoming: FieldFactorDescriptorRow
): boolean {
  return sameFactorDescriptorFields(existing, incoming);
}
