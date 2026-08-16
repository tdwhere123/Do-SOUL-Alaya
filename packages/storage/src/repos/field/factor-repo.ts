import type { StorageDatabase } from "../../sqlite/db.js";
import { parseOptionalRow } from "../shared/parse-row.js";
import {
  fieldDerivationJobParser,
  fieldFactorDescriptorParser,
  fieldFactorIncidenceParser,
  insertIdempotent
} from "./mappers.js";
import type {
  FieldDerivationJobRepo,
  FieldDerivationJobRow,
  FieldFactorDescriptorRow,
  FieldFactorIncidenceRow,
  FieldFactorRepo
} from "./ports.js";

export class SqliteFieldFactorRepo implements FieldFactorRepo {
  private readonly insertDescriptorStatement;
  private readonly selectDescriptorStatement;
  private readonly insertIncidenceStatement;
  private readonly selectIncidenceStatement;

  public constructor(database: StorageDatabase) {
    this.insertDescriptorStatement = database.connection.prepare(`
      INSERT INTO factor_descriptors (
        factor_id, family, canonical_payload, operator_version
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(factor_id) DO NOTHING
    `);
    this.selectDescriptorStatement = database.connection.prepare(`
      SELECT factor_id, family, canonical_payload, operator_version
      FROM factor_descriptors WHERE factor_id = ? LIMIT 1
    `);
    this.insertIncidenceStatement = database.connection.prepare(`
      INSERT INTO factor_incidences (
        incidence_id, span_id, factor_id, scope, operator_version, workspace_id
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(incidence_id) DO NOTHING
    `);
    this.selectIncidenceStatement = database.connection.prepare(`
      SELECT incidence_id, span_id, factor_id, scope, operator_version, workspace_id
      FROM factor_incidences WHERE incidence_id = ? LIMIT 1
    `);
  }

  public insertDescriptor(row: FieldFactorDescriptorRow): FieldFactorDescriptorRow {
    return insertIdempotent(
      () => this.insertDescriptorStatement.run(
        row.factor_id, row.family, row.canonical_payload, row.operator_version
      ),
      () => this.findDescriptor(row.factor_id),
      (existing) => existing.family === row.family &&
        existing.canonical_payload === row.canonical_payload &&
        existing.operator_version === row.operator_version,
      "factor descriptor"
    );
  }

  public insertIncidence(row: FieldFactorIncidenceRow): FieldFactorIncidenceRow {
    return insertIdempotent(
      () => this.insertIncidenceStatement.run(
        row.incidence_id, row.span_id, row.factor_id, row.scope,
        row.operator_version, row.workspace_id
      ),
      () => this.findIncidence(row.incidence_id),
      (existing) => existing.span_id === row.span_id &&
        existing.factor_id === row.factor_id &&
        existing.scope === row.scope &&
        existing.operator_version === row.operator_version &&
        existing.workspace_id === row.workspace_id,
      "factor incidence"
    );
  }

  public findDescriptor(factorId: string): FieldFactorDescriptorRow | null {
    return parseOptionalRow(
      this.selectDescriptorStatement.get(factorId),
      fieldFactorDescriptorParser,
      "factor descriptor"
    );
  }

  public findIncidence(incidenceId: string): FieldFactorIncidenceRow | null {
    return parseOptionalRow(
      this.selectIncidenceStatement.get(incidenceId),
      fieldFactorIncidenceParser,
      "factor incidence"
    );
  }
}

export class SqliteFieldDerivationJobRepo implements FieldDerivationJobRepo {
  private readonly insertStatement;
  private readonly selectStatement;

  public constructor(database: StorageDatabase) {
    this.insertStatement = database.connection.prepare(`
      INSERT INTO derivation_jobs (
        job_id, purpose, operator_version, input_evidence_ids_json, status, disposition
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO NOTHING
    `);
    this.selectStatement = database.connection.prepare(`
      SELECT job_id, purpose, operator_version, input_evidence_ids_json, status, disposition
      FROM derivation_jobs WHERE job_id = ? LIMIT 1
    `);
  }

  public insert(row: FieldDerivationJobRow): FieldDerivationJobRow {
    return insertIdempotent(
      () => this.insertStatement.run(
        row.job_id, row.purpose, row.operator_version,
        row.input_evidence_ids_json, row.status, row.disposition
      ),
      () => this.findById(row.job_id),
      (existing) => existing.purpose === row.purpose &&
        existing.operator_version === row.operator_version &&
        existing.input_evidence_ids_json === row.input_evidence_ids_json &&
        existing.status === row.status &&
        existing.disposition === row.disposition,
      "derivation job"
    );
  }

  public findById(jobId: string): FieldDerivationJobRow | null {
    return parseOptionalRow(
      this.selectStatement.get(jobId),
      fieldDerivationJobParser,
      "derivation job"
    );
  }
}
