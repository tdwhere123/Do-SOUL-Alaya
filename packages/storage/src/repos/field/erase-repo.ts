import {
  ProjectionEraseSubjectKindSchema,
  hashLabeledIdentity,
  type FieldContractSha256,
  type ProjectionEraseSubjectKind
} from "@do-soul/alaya-protocol";
import { StorageError } from "../../shared/errors.js";
import type { StorageDatabase } from "../../sqlite/db.js";
import { RefreshableStatementHolder } from "../../sqlite/refreshable-statement-holder.js";
import {
  parseOptionalRow,
  parseRows,
  readNonEmptyStringField,
  readRecord,
  type RowParser
} from "../shared/parse-row.js";
import {
  fieldEraseBarrierParser,
  insertIdempotent,
  persistFieldTransaction
} from "./mappers.js";
import type {
  FieldEraseBarrierInput,
  FieldEraseBarrierRepo,
  FieldEraseBarrierRow
} from "./ports.js";
import { scrubDerivedPrivacyClosure } from "./erase/derived-closure.js";

type EraseSubject = Readonly<{
  subject_kind: ProjectionEraseSubjectKind;
  subject_id: string;
}>;

type EraseClosure = Readonly<{
  subjects: readonly EraseSubject[];
  evidenceIds: readonly string[];
}>;

const eraseSubjectParser: RowParser<EraseSubject> = {
  parse(value: unknown): EraseSubject {
    const row = readRecord(value, "erase descendant");
    return Object.freeze({
      subject_kind: ProjectionEraseSubjectKindSchema.parse(
        readNonEmptyStringField(row, "subject_kind")
      ),
      subject_id: readNonEmptyStringField(row, "subject_id")
    });
  }
};

const evidenceIdParser: RowParser<string> = {
  parse(value: unknown): string {
    return readNonEmptyStringField(readRecord(value, "erase evidence binding"), "evidence_id");
  }
};

export class SqliteFieldEraseBarrierRepo implements FieldEraseBarrierRepo {
  private readonly statements: RefreshableStatementHolder<ReturnType<typeof prepareEraseStatements>>;

  public constructor(
    private readonly database: StorageDatabase,
    private readonly sha256: FieldContractSha256
  ) {
    this.statements = new RefreshableStatementHolder(database, prepareEraseStatements);
  }

  public get transactionScope(): object {
    return this.database;
  }

  public apply(input: FieldEraseBarrierInput): FieldEraseBarrierRow {
    const row = canonicalBarrier(input, this.sha256);
    return persistFieldTransaction(this.database, () => {
      const existing = this.findById(row.workspace_id, row.barrier_id) ??
        this.findBySubject(row.workspace_id, row.subject_kind, row.subject_id);
      if (existing !== null) {
        return requireCompatibleBarrier(existing, row);
      }
      const closure = this.discoverClosure(row);
      const stored = this.insertBarrier(row);
      this.insertDescendantBarriers(stored, closure.subjects);
      this.scrubEvidence(stored, closure.evidenceIds);
      this.scrubSubjects(stored, closure.subjects);
      this.invalidateGenerations(stored.workspace_id, closure.subjects);
      return stored;
    }, "erase barrier");
  }

  public isErased(workspaceId: string, subjectId: string): boolean {
    return this.statements.active().selectBySubjectIdStatement.get(workspaceId, subjectId) !==
      undefined;
  }

  public findById(workspaceId: string, barrierId: string): FieldEraseBarrierRow | null {
    return parseOptionalRow(
      this.statements.active().selectStatement.get(workspaceId, barrierId),
      fieldEraseBarrierParser,
      "erase barrier"
    );
  }

  private findBySubject(
    workspaceId: string,
    subjectKind: ProjectionEraseSubjectKind,
    subjectId: string
  ): FieldEraseBarrierRow | null {
    return parseOptionalRow(
      this.statements.active().selectBySubjectStatement.get(
        workspaceId,
        subjectKind,
        subjectId
      ),
      fieldEraseBarrierParser,
      "erase barrier subject"
    );
  }

  private insertBarrier(row: FieldEraseBarrierRow): FieldEraseBarrierRow {
    const existing = this.findById(row.workspace_id, row.barrier_id) ??
      this.findBySubject(row.workspace_id, row.subject_kind, row.subject_id);
    if (existing !== null) return requireCompatibleBarrier(existing, row);
    return insertIdempotent(
      () => this.statements.active().insertStatement.run(
        row.barrier_id, row.identity, row.workspace_id, row.generation_id,
        row.subject_kind, row.subject_id, row.erased_at
      ),
      () => this.findById(row.workspace_id, row.barrier_id),
      (existing) => sameBarrier(existing, row),
      "erase barrier"
    );
  }

  private discoverClosure(row: FieldEraseBarrierRow): EraseClosure {
    const subjects = this.discoverSubjects(row);
    return {
      subjects: row.subject_kind === "generation"
        ? subjects
        : [...subjects, ...this.discoverGenerations(row.workspace_id)],
      evidenceIds: row.subject_kind === "source_record"
        ? this.discoverEvidenceIds(row.workspace_id, row.subject_id)
        : []
    };
  }

  private discoverSubjects(row: FieldEraseBarrierRow): readonly EraseSubject[] {
    const sql = descendantSql(row.subject_kind);
    if (sql === null) return [{ subject_kind: row.subject_kind, subject_id: row.subject_id }];
    const descendants = parseRows(
      this.database.connection.prepare(sql).all({
        workspaceId: row.workspace_id,
        subjectId: row.subject_id
      }),
      eraseSubjectParser,
      "erase descendant"
    );
    return [{ subject_kind: row.subject_kind, subject_id: row.subject_id }, ...descendants];
  }

  private discoverEvidenceIds(workspaceId: string, recordId: string): readonly string[] {
    return parseRows(this.database.connection.prepare(`
      SELECT evidence_object_id AS evidence_id
      FROM source_record_evidence_refs
      WHERE workspace_id = @workspaceId AND record_id = @subjectId
      ORDER BY evidence_object_id
    `).all({ workspaceId, subjectId: recordId }), evidenceIdParser, "erase evidence binding");
  }

  private discoverGenerations(workspaceId: string): readonly EraseSubject[] {
    return parseRows(this.database.connection.prepare(`
      SELECT 'generation' AS subject_kind, generation_id AS subject_id
      FROM projection_generations
      WHERE workspace_id = ?
      ORDER BY generation_id
    `).all(workspaceId), eraseSubjectParser, "erase generation descendant");
  }

  private insertDescendantBarriers(
    root: FieldEraseBarrierRow,
    subjects: readonly EraseSubject[]
  ): void {
    for (const subject of subjects) {
      if (subject.subject_kind === root.subject_kind && subject.subject_id === root.subject_id) {
        continue;
      }
      this.insertBarrier({
        ...root,
        barrier_id: descendantBarrierId(root, subject, this.sha256),
        identity: barrierReceiptIdentity(root.workspace_id, subject, root.generation_id, this.sha256),
        subject_kind: subject.subject_kind,
        subject_id: subject.subject_id
      });
    }
  }

  private scrubEvidence(root: FieldEraseBarrierRow, evidenceIds: readonly string[]): void {
    const connection = this.database.connection;
    scrubDerivedPrivacyClosure(this.database, root, evidenceIds);
    const deletes = [
      "DELETE FROM evidence_search_projections WHERE workspace_id = ? AND evidence_object_id = ?",
      "DELETE FROM evidence_recall_embeddings WHERE workspace_id = ? AND owner_object_id = ?",
      "DELETE FROM evidence_fact_frame_formations WHERE workspace_id = ? AND evidence_object_id = ?",
      "DELETE FROM evidence_semantic_factor_formations WHERE workspace_id = ? AND evidence_object_id = ?"
    ].map((sql) => connection.prepare(sql));
    const scrubCapsule = connection.prepare(`
      UPDATE evidence_capsules
      SET lifecycle_state = 'tombstone', evidence_health_state = 'broken',
          semantic_anchor = '{"topic":"erased","keywords":["erased"],"summary":"erased"}',
          event_anchor = NULL, physical_anchor = NULL, gist = 'erased',
          excerpt = NULL, source_hash = NULL, updated_at = ?
      WHERE workspace_id = ? AND object_id = ?
    `);
    for (const evidenceId of evidenceIds) {
      for (const statement of deletes) statement.run(root.workspace_id, evidenceId);
      scrubCapsule.run(root.erased_at, root.workspace_id, evidenceId);
    }
  }

  private scrubSubjects(root: FieldEraseBarrierRow, subjects: readonly EraseSubject[]): void {
    const connection = this.database.connection;
    const deletes = {
      incidence: connection.prepare(
        "DELETE FROM factor_incidences WHERE workspace_id = ? AND incidence_id = ?"
      ),
      source_span: connection.prepare(
        "DELETE FROM source_spans WHERE workspace_id = ? AND span_id = ?"
      )
    };
    const clearFactor = connection.prepare(`
      UPDATE factor_descriptors SET canonical_payload = NULL
      WHERE workspace_id = ? AND factor_id = ?
    `);
    const clearRecord = connection.prepare(`
      UPDATE source_records SET source_body = NULL
      WHERE workspace_id = ? AND record_id = ?
    `);
    for (const subject of subjects) {
      if (subject.subject_kind === "incidence") {
        deletes.incidence.run(root.workspace_id, subject.subject_id);
      } else if (subject.subject_kind === "source_span") {
        deletes.source_span.run(root.workspace_id, subject.subject_id);
      } else if (subject.subject_kind === "factor") {
        clearFactor.run(root.workspace_id, subject.subject_id);
      } else if (subject.subject_kind === "source_record") {
        clearRecord.run(root.workspace_id, subject.subject_id);
      }
    }
  }

  private invalidateGenerations(workspaceId: string, subjects: readonly EraseSubject[]): void {
    const connection = this.database.connection;
    const deletePointer = connection.prepare(`
      DELETE FROM projection_generation_pointer
      WHERE workspace_id = ? AND active_generation_id = ?
    `);
    const retire = connection.prepare(`
      UPDATE projection_generations SET status = 'retired'
      WHERE workspace_id = ? AND generation_id = ? AND status = 'active'
    `);
    const deletePins = connection.prepare(
      "DELETE FROM projection_pins WHERE workspace_id = ? AND generation_id = ?"
    );
    const deleteArtifacts = connection.prepare(`
      DELETE FROM projection_generation_artifacts
      WHERE workspace_id = ? AND generation_id = ?
    `);
    for (const subject of subjects) {
      if (subject.subject_kind !== "generation") continue;
      deletePointer.run(workspaceId, subject.subject_id);
      retire.run(workspaceId, subject.subject_id);
      deletePins.run(workspaceId, subject.subject_id);
      deleteArtifacts.run(workspaceId, subject.subject_id);
    }
  }
}

function prepareEraseStatements(database: StorageDatabase) {
  return {
    insertStatement: database.connection.prepare(`
      INSERT INTO projection_erase_barriers (
        barrier_id, receipt_identity, workspace_id, generation_id, subject_kind, subject_id, erased_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, barrier_id) DO NOTHING
    `),
    selectStatement: database.connection.prepare(`
      SELECT receipt_identity AS identity, barrier_id, workspace_id, generation_id,
        subject_kind, subject_id, erased_at
      FROM projection_erase_barriers
      WHERE workspace_id = ? AND barrier_id = ? LIMIT 1
    `),
    selectBySubjectStatement: database.connection.prepare(`
      SELECT receipt_identity AS identity, barrier_id, workspace_id, generation_id,
        subject_kind, subject_id, erased_at
      FROM projection_erase_barriers
      WHERE workspace_id = ? AND subject_kind = ? AND subject_id = ? LIMIT 1
    `),
    selectBySubjectIdStatement: database.connection.prepare(`
      SELECT 1 FROM projection_erase_barriers
      WHERE workspace_id = ? AND subject_id = ? LIMIT 1
    `)
  };
}

function descendantSql(kind: ProjectionEraseSubjectKind): string | null {
  if (kind === "source_record") return `
    SELECT 'source_span' AS subject_kind, span_id AS subject_id FROM source_spans
      WHERE workspace_id = @workspaceId AND record_id = @subjectId
    UNION SELECT 'incidence', incidence.incidence_id
      FROM factor_incidences AS incidence
      JOIN source_spans AS span
        ON span.workspace_id = incidence.workspace_id AND span.span_id = incidence.span_id
      WHERE span.workspace_id = @workspaceId AND span.record_id = @subjectId
    UNION SELECT 'factor', incidence.factor_id
      FROM factor_incidences AS incidence
      JOIN source_spans AS span
        ON span.workspace_id = incidence.workspace_id AND span.span_id = incidence.span_id
      WHERE span.workspace_id = @workspaceId AND span.record_id = @subjectId
    ORDER BY subject_kind, subject_id
  `;
  if (kind === "source_span") return `
    SELECT 'incidence' AS subject_kind, incidence_id AS subject_id FROM factor_incidences
      WHERE workspace_id = @workspaceId AND span_id = @subjectId
    UNION SELECT 'factor', factor_id FROM factor_incidences
      WHERE workspace_id = @workspaceId AND span_id = @subjectId
    ORDER BY subject_kind, subject_id
  `;
  if (kind === "factor") return `
    SELECT 'incidence' AS subject_kind, incidence_id AS subject_id FROM factor_incidences
      WHERE workspace_id = @workspaceId AND factor_id = @subjectId
    ORDER BY subject_kind, subject_id
  `;
  return null;
}

function descendantBarrierId(
  root: FieldEraseBarrierRow,
  subject: EraseSubject,
  sha256: FieldContractSha256
): string {
  return `sha256:${sha256(JSON.stringify([
    "projection-erase-descendant-v1",
    root.barrier_id,
    subject.subject_kind,
    subject.subject_id
  ]))}`;
}

function requireCompatibleBarrier(
  existing: FieldEraseBarrierRow,
  incoming: FieldEraseBarrierRow
): FieldEraseBarrierRow {
  if (!sameBarrier(existing, incoming)) {
    throw new StorageError("CONFLICT", "erase barrier identity collision");
  }
  return existing;
}

function sameBarrier(existing: FieldEraseBarrierRow, incoming: FieldEraseBarrierRow): boolean {
  return existing.identity === incoming.identity &&
    existing.generation_id === incoming.generation_id &&
    existing.subject_kind === incoming.subject_kind &&
    existing.subject_id === incoming.subject_id;
}

function canonicalBarrier(
  row: FieldEraseBarrierInput,
  sha256: FieldContractSha256
): FieldEraseBarrierRow {
  const expected = barrierReceiptIdentity(
    row.workspace_id,
    row,
    row.generation_id,
    sha256
  );
  if (row.identity !== undefined && row.identity !== expected) {
    throw new StorageError("VALIDATION_FAILED", "erase barrier receipt identity mismatch");
  }
  return Object.freeze({ ...row, identity: expected });
}

function barrierReceiptIdentity(
  workspaceId: string,
  subject: EraseSubject,
  generationId: string | null,
  sha256: FieldContractSha256
): string {
  return hashLabeledIdentity("erase_barrier", [
    workspaceId,
    subject.subject_kind,
    subject.subject_id,
    generationId ?? ""
  ], sha256);
}
