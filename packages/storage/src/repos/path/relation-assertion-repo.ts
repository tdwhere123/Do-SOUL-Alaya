import {
  RelationAssertionResolutionSchema,
  RelationAssertionSchema,
  RelationFormationSourceKind,
  type PathRelation,
  type RelationAssertion,
  type RelationAssertionEvidenceReceipt,
  type RelationAssertionResolution,
  type RelationFormationReceipt,
  type RelationFormationSourceObservation
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";
import { parseOptionalRow, parseRows } from "../shared/parse-row.js";
import { EventLogEntryRowParser } from "../runtime/event-log-rows.js";
import {
  requireUniqueRelationAssertionEvidenceIds,
  wrapRelationAssertionStorageError
} from "./relation-assertion-repo-support.js";
import {
  findActiveProjectionById,
  findActiveProjectionByWorkspace,
  findProjectionByWorkspaceAtAsOf,
  readActiveProjectionGeneration,
  readCurrentHistoryDigest
} from "./relation-assertion/projection-reader.js";
import type { RelationAssertionProjectionGeneration } from "./relation-assertion/projection-types.js";
import {
  markProjectionRefreshRequired,
  writeProjectionGeneration
} from "./relation-assertion/projection-writer.js";
import { digestRelationFormationEventSource } from "./relation-assertion/source-digest.js";
import {
  AssertionRowParser,
  EvidenceReceiptVerificationRowParser,
  HqFormationSourceRowParser,
  ResolutionRowParser,
  matchesHqSourceReceipt,
  verifyEvidenceReceipt
} from "./relation-assertion/row-mappers.js";

export type { RelationAssertionProjectionGeneration } from "./relation-assertion/projection-types.js";

export interface RelationAssertionRepo {
  getStorageConnectionIdentity(): object;
  readActiveProjectionGenerationInCurrentTransaction(): string | null;
  readCurrentHistoryDigestInCurrentTransaction(): string | null;
  getByIdInCurrentTransaction(assertionId: string): Readonly<RelationAssertion> | null;
  findByIdentityKeyInCurrentTransaction(identityKey: string): Readonly<RelationAssertion> | null;
  createInCurrentTransaction(input: {
    readonly assertion: RelationAssertion;
    readonly identityKey: string;
  }): Readonly<RelationAssertion>;
  markProjectionRefreshRequiredInCurrentTransaction(): void;
  assertFormationInputsInCurrentTransaction(input: {
    readonly workspaceId: string;
    readonly evidenceReceipts: readonly RelationAssertionEvidenceReceipt[];
    readonly formationReceipt: RelationFormationReceipt;
  }): void;
  getCurrentResolutionInCurrentTransaction(
    assertionId: string
  ): Readonly<RelationAssertionResolution> | null;
  createCurrentResolutionInCurrentTransaction(
    resolution: RelationAssertionResolution
  ): Readonly<RelationAssertionResolution>;
  listAssertionsInCurrentTransaction(): readonly Readonly<RelationAssertion>[];
  listCurrentResolutionsInCurrentTransaction(): readonly Readonly<RelationAssertionResolution>[];
  writeProjectionGenerationInCurrentTransaction(
    generation: RelationAssertionProjectionGeneration,
    options: { readonly activate: boolean }
  ): string;
  findActiveProjectionByWorkspace(
    workspaceId: string
  ): Promise<readonly Readonly<PathRelation>[]>;
  findActiveProjectionById(pathId: string): Promise<Readonly<PathRelation> | null>;
  findProjectionByWorkspaceAtAsOf(
    workspaceId: string,
    asOf: string
  ): Promise<readonly Readonly<PathRelation>[] | null>;
}
export class SqliteRelationAssertionRepo implements RelationAssertionRepo {
  private readonly assertEvidenceReceiptsStatement;
  private readonly findEventFormationSourceStatement;
  private readonly findHqFormationSourceStatement;

  public constructor(private readonly db: StorageDatabase) {
    this.assertEvidenceReceiptsStatement = db.connection.prepare(`
      WITH receipts AS (
        SELECT json_extract(value, '$.evidence_id') AS evidence_id,
               json_extract(value, '$.source_event_anchor.event_type') AS source_event_type,
               json_extract(value, '$.source_event_anchor.event_id') AS source_event_id
        FROM json_each(?)
      )
      SELECT receipt.evidence_id, evidence.workspace_id, evidence.event_anchor,
             source.event_id AS verified_source_event_id
      FROM receipts AS receipt
      LEFT JOIN evidence_capsules AS evidence
        ON evidence.object_id = receipt.evidence_id
      LEFT JOIN event_log AS source
        ON source.event_id = receipt.source_event_id
       AND source.event_type = receipt.source_event_type
       AND source.workspace_id = evidence.workspace_id
    `);
    this.findEventFormationSourceStatement = db.connection.prepare(`
      SELECT event_id, event_type, entity_type, entity_id, workspace_id, run_id,
             caused_by, revision, payload_json, created_at
      FROM event_log
      WHERE event_id = ?
      LIMIT 1
    `);
    this.findHqFormationSourceStatement = db.connection.prepare(`
      SELECT observation_id, workspace_id, evidence_id, source_event_type,
             source_event_id, source_occurred_at, observation_sha256
      FROM memory_hq_observations
      WHERE observation_id = ?
      LIMIT 1
    `);
  }

  public getStorageConnectionIdentity(): StorageDatabase {
    return this.db;
  }

  public readActiveProjectionGenerationInCurrentTransaction(): string | null {
    return readActiveProjectionGeneration(this.db);
  }

  public readCurrentHistoryDigestInCurrentTransaction(): string | null {
    return readCurrentHistoryDigest(this.db);
  }

  public getByIdInCurrentTransaction(assertionId: string): Readonly<RelationAssertion> | null {
    try {
      return parseOptionalRow(this.db.connection.prepare(`
        SELECT assertion_id, workspace_id, admission_event_id, anchors_json, relation_kind,
               validity_json, formation_receipt_json, admitted_at,
               (SELECT json_group_array(json(receipt_json))
                  FROM (
                    SELECT json_object(
                      'evidence_id', evidence_id,
                      'source_event_anchor', json_object(
                        'event_type', source_event_type,
                        'event_id', source_event_id,
                        'occurred_at', source_occurred_at
                      )
                    ) AS receipt_json
                    FROM relation_assertion_evidence
                    WHERE assertion_id = relation_assertions.assertion_id
                    ORDER BY evidence_id ASC
                  )) AS evidence_receipts_json
        FROM relation_assertions
        WHERE assertion_id = ?
        LIMIT 1
      `).get(assertionId),
        AssertionRowParser,
        "relation assertion row"
      );
    } catch (error) {
      throw wrapRelationAssertionStorageError("load relation assertion", error);
    }
  }
  public findByIdentityKeyInCurrentTransaction(identityKey: string): Readonly<RelationAssertion> | null {
    try {
      return parseOptionalRow(this.db.connection.prepare(`
        SELECT assertion_id, workspace_id, admission_event_id, anchors_json, relation_kind,
               validity_json, formation_receipt_json, admitted_at,
               (SELECT json_group_array(json(receipt_json))
                  FROM (
                    SELECT json_object(
                      'evidence_id', evidence_id,
                      'source_event_anchor', json_object(
                        'event_type', source_event_type,
                        'event_id', source_event_id,
                        'occurred_at', source_occurred_at
                      )
                    ) AS receipt_json
                    FROM relation_assertion_evidence
                    WHERE assertion_id = relation_assertions.assertion_id
                    ORDER BY evidence_id ASC
                  )) AS evidence_receipts_json
        FROM relation_assertions
        WHERE identity_key = ?
        LIMIT 1
      `).get(identityKey),
        AssertionRowParser,
        "relation assertion row"
      );
    } catch (error) {
      throw wrapRelationAssertionStorageError("look up relation assertion identity", error);
    }
  }
  public createInCurrentTransaction(input: {
    readonly assertion: RelationAssertion;
    readonly identityKey: string;
  }): Readonly<RelationAssertion> {
    const assertion = RelationAssertionSchema.parse(input.assertion);
    requireUniqueRelationAssertionEvidenceIds(
      assertion.evidence_receipts.map((receipt) => receipt.evidence_id)
    );
    try {
      this.db.connection.prepare(`
        INSERT INTO relation_assertions (
          assertion_id, workspace_id, admission_event_id, identity_key,
          anchors_json, relation_kind, validity_json, formation_receipt_json, admitted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        assertion.assertion_id,
        assertion.workspace_id,
        assertion.admission_event_id,
        input.identityKey,
        JSON.stringify(assertion.anchors),
        assertion.relation_kind,
        JSON.stringify(assertion.validity),
        JSON.stringify(assertion.formation_receipt),
        assertion.admitted_at
      );
      const insertEvidence = this.db.connection.prepare(`
        INSERT INTO relation_assertion_evidence (
          assertion_id, evidence_id, source_event_type, source_event_id, source_occurred_at
        ) VALUES (?, ?, ?, ?, ?)
      `);
      for (const receipt of assertion.evidence_receipts) {
        insertEvidence.run(
          assertion.assertion_id,
          receipt.evidence_id,
          receipt.source_event_anchor.event_type,
          receipt.source_event_anchor.event_id,
          receipt.source_event_anchor.occurred_at
        );
      }
      const persisted = this.getByIdInCurrentTransaction(assertion.assertion_id);
      if (persisted === null) {
        throw new StorageError("NOT_FOUND", `Relation assertion ${assertion.assertion_id} was not found after insert.`);
      }
      return persisted;
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw wrapRelationAssertionStorageError(`create relation assertion ${assertion.assertion_id}`, error);
    }
  }

  public markProjectionRefreshRequiredInCurrentTransaction(): void {
    markProjectionRefreshRequired(this.db);
  }

  public assertFormationInputsInCurrentTransaction(input: {
    readonly workspaceId: string;
    readonly evidenceReceipts: readonly RelationAssertionEvidenceReceipt[];
    readonly formationReceipt: RelationFormationReceipt;
  }): void {
    this.verifyEvidenceReceipts(input.workspaceId, input.evidenceReceipts);
    this.verifyFormationSources(input.workspaceId, input.evidenceReceipts, input.formationReceipt);
  }

  private verifyEvidenceReceipts(
    workspaceId: string,
    evidenceReceipts: readonly RelationAssertionEvidenceReceipt[]
  ): void {
    requireUniqueRelationAssertionEvidenceIds(evidenceReceipts.map((receipt) => receipt.evidence_id));
    try {
      const rows = parseRows(
        this.assertEvidenceReceiptsStatement.all(JSON.stringify(evidenceReceipts)),
        EvidenceReceiptVerificationRowParser,
        "relation assertion evidence receipt verification row"
      );
      const rowByEvidenceId = new Map(rows.map((row) => [row.evidence_id, row]));
      for (const receipt of evidenceReceipts) {
        verifyEvidenceReceipt(workspaceId, receipt, rowByEvidenceId.get(receipt.evidence_id));
      }
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw wrapRelationAssertionStorageError("verify relation assertion evidence receipts", error);
    }
  }

  private verifyFormationSources(
    workspaceId: string,
    evidenceReceipts: readonly RelationAssertionEvidenceReceipt[],
    formationReceipt: RelationFormationReceipt
  ): void {
    const receiptByEvidenceId = new Map(evidenceReceipts.map((receipt) => [receipt.evidence_id, receipt]));
    for (const source of formationReceipt.source_observations) {
      if (source.source_kind === RelationFormationSourceKind.EVENT_LOG_ENTRY) {
        this.verifyEventFormationSource(workspaceId, source);
      } else {
        this.verifyHqFormationSource(workspaceId, source, receiptByEvidenceId);
      }
    }
  }

  private verifyEventFormationSource(
    workspaceId: string,
    source: RelationFormationSourceObservation
  ): void {
    const entry = parseOptionalRow(
      this.findEventFormationSourceStatement.get(source.source_id),
      EventLogEntryRowParser,
      "formation event log source"
    );
    if (entry === null || entry.workspace_id !== workspaceId) {
      throw new StorageError("NOT_FOUND", `Formation EventLog source ${source.source_id} is unavailable.`);
    }
    if (digestRelationFormationEventSource(entry) !== source.source_sha256) {
      throw new StorageError("CONFLICT", `Formation EventLog source ${source.source_id} digest does not match.`);
    }
  }

  private verifyHqFormationSource(
    workspaceId: string,
    source: RelationFormationSourceObservation,
    receiptByEvidenceId: ReadonlyMap<string, RelationAssertionEvidenceReceipt>
  ): void {
    const row = parseOptionalRow(
      this.findHqFormationSourceStatement.get(source.source_id),
      HqFormationSourceRowParser,
      "hq formation source row"
    );
    if (row === null || row.workspace_id !== workspaceId) {
      throw new StorageError("NOT_FOUND", `Formation HQ source ${source.source_id} is unavailable.`);
    }
    if (row.observation_sha256 !== source.source_sha256) {
      throw new StorageError("CONFLICT", `Formation HQ source ${source.source_id} digest does not match.`);
    }
    const receipt = receiptByEvidenceId.get(row.evidence_id);
    if (receipt === undefined || !matchesHqSourceReceipt(row, receipt)) {
      throw new StorageError("CONFLICT", `Formation HQ source ${source.source_id} is not bound to admitted Evidence.`);
    }
  }

  public getCurrentResolutionInCurrentTransaction(
    assertionId: string
  ): Readonly<RelationAssertionResolution> | null {
    try {
      return parseOptionalRow(
        this.db.connection.prepare(`
        SELECT resolution_id, assertion_id, workspace_id, resolution_event_id,
               resolution_kind, resolved_at, reason
        FROM relation_assertion_resolution_current
        WHERE assertion_id = ?
        LIMIT 1
      `).get(assertionId),
        ResolutionRowParser,
        "relation assertion resolution row"
      );
    } catch (error) {
      throw wrapRelationAssertionStorageError("load relation assertion resolution", error);
    }
  }

  public createCurrentResolutionInCurrentTransaction(
    resolution: RelationAssertionResolution
  ): Readonly<RelationAssertionResolution> {
    const parsed = RelationAssertionResolutionSchema.parse(resolution);
    try {
      this.db.connection.prepare(`
        INSERT INTO relation_assertion_resolution_current (
          assertion_id, resolution_id, workspace_id, resolution_event_id, resolution_kind,
          resolved_at, reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        parsed.assertion_id,
        parsed.resolution_id,
        parsed.workspace_id,
        parsed.event_id,
        parsed.resolution_kind,
        parsed.resolved_at,
        parsed.reason
      );
      const persisted = this.getCurrentResolutionInCurrentTransaction(parsed.assertion_id);
      if (persisted === null) {
        throw new StorageError("NOT_FOUND", `Resolution for ${parsed.assertion_id} was not found after insert.`);
      }
      return persisted;
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw wrapRelationAssertionStorageError(`create relation assertion resolution ${parsed.resolution_id}`, error);
    }
  }

  public listAssertionsInCurrentTransaction(): readonly Readonly<RelationAssertion>[] {
    try {
      const rows = parseRows(this.db.connection.prepare(`
        SELECT assertion_id, workspace_id, admission_event_id, anchors_json, relation_kind,
               validity_json, formation_receipt_json, admitted_at,
               (SELECT json_group_array(json(receipt_json))
                  FROM (
                    SELECT json_object(
                      'evidence_id', evidence_id,
                      'source_event_anchor', json_object(
                        'event_type', source_event_type,
                        'event_id', source_event_id,
                        'occurred_at', source_occurred_at
                      )
                    ) AS receipt_json
                    FROM relation_assertion_evidence
                    WHERE assertion_id = relation_assertions.assertion_id
                    ORDER BY evidence_id ASC
                  )) AS evidence_receipts_json
        FROM relation_assertions
        ORDER BY admitted_at ASC, assertion_id ASC
      `).all(),
        AssertionRowParser,
        "relation assertion row"
      );
      return Object.freeze(rows);
    } catch (error) {
      throw wrapRelationAssertionStorageError("list relation assertions", error);
    }
  }

  public listCurrentResolutionsInCurrentTransaction(): readonly Readonly<RelationAssertionResolution>[] {
    try {
      const rows = parseRows(this.db.connection.prepare(`
        SELECT resolution_id, assertion_id, workspace_id, resolution_event_id,
               resolution_kind, resolved_at, reason
        FROM relation_assertion_resolution_current
        ORDER BY resolved_at ASC, resolution_id ASC
      `).all(),
        ResolutionRowParser,
        "relation assertion resolution row"
      );
      return Object.freeze(rows);
    } catch (error) {
      throw wrapRelationAssertionStorageError("list relation assertion resolutions", error);
    }
  }

  public writeProjectionGenerationInCurrentTransaction(
    generation: RelationAssertionProjectionGeneration,
    options: { readonly activate: boolean }
  ): string {
    return writeProjectionGeneration(this.db, generation, options);
  }

  public async findActiveProjectionByWorkspace(
    workspaceId: string
  ): Promise<readonly Readonly<PathRelation>[]> {
    return await findActiveProjectionByWorkspace(this.db, workspaceId);
  }

  public async findActiveProjectionById(pathId: string): Promise<Readonly<PathRelation> | null> {
    return await findActiveProjectionById(this.db, pathId);
  }

  public async findProjectionByWorkspaceAtAsOf(
    workspaceId: string,
    asOf: string
  ): Promise<readonly Readonly<PathRelation>[] | null> {
    return await findProjectionByWorkspaceAtAsOf(this.db, workspaceId, asOf);
  }
}
