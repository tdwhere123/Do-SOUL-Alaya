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
import { parseEventLogEntryRow, type EventLogRow } from "../runtime/event-log-rows.js";
import {
  requireUniqueRelationAssertionEvidenceIds,
  wrapRelationAssertionStorageError
} from "./relation-assertion-repo-support.js";
import {
  findActiveProjectionById,
  findActiveProjectionByWorkspace,
  findProjectionByWorkspaceAtAsOf,
  readActiveProjectionGeneration
} from "./relation-assertion/projection-reader.js";
import type { RelationAssertionProjectionGeneration } from "./relation-assertion/projection-types.js";
import { writeProjectionGeneration } from "./relation-assertion/projection-writer.js";
import { digestRelationFormationEventSource } from "./relation-assertion/source-digest.js";
import {
  parseAssertionRow,
  parseResolutionRow,
  type AssertionRow,
  type ResolutionRow
} from "./relation-assertion/row-mappers.js";

export type { RelationAssertionProjectionGeneration } from "./relation-assertion/projection-types.js";

interface EvidenceReceiptVerificationRow {
  readonly evidence_id: string;
  readonly workspace_id: string | null;
  readonly event_anchor: string | null;
  readonly verified_source_event_id: string | null;
}

interface HqFormationSourceRow {
  readonly observation_id: string;
  readonly workspace_id: string;
  readonly evidence_id: string;
  readonly source_event_type: string;
  readonly source_event_id: string;
  readonly source_occurred_at: string;
  readonly observation_sha256: string;
}

export interface RelationAssertionRepo {
  getStorageConnectionIdentity(): object;
  readActiveProjectionGenerationInCurrentTransaction(): string | null;
  getByIdInCurrentTransaction(assertionId: string): Readonly<RelationAssertion> | null;
  findByIdentityKeyInCurrentTransaction(identityKey: string): Readonly<RelationAssertion> | null;
  createInCurrentTransaction(input: {
    readonly assertion: RelationAssertion;
    readonly identityKey: string;
  }): Readonly<RelationAssertion>;
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
  ): void;
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

  public getByIdInCurrentTransaction(assertionId: string): Readonly<RelationAssertion> | null {
    try {
      const row = this.db.connection.prepare(`
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
      `).get(assertionId) as AssertionRow | undefined;
      return row === undefined ? null : parseAssertionRow(row);
    } catch (error) {
      throw wrapRelationAssertionStorageError("load relation assertion", error);
    }
  }
  public findByIdentityKeyInCurrentTransaction(identityKey: string): Readonly<RelationAssertion> | null {
    try {
      const row = this.db.connection.prepare(`
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
      `).get(identityKey) as AssertionRow | undefined;
      return row === undefined ? null : parseAssertionRow(row);
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
      const rows = this.assertEvidenceReceiptsStatement.all(
        JSON.stringify(evidenceReceipts)
      ) as readonly EvidenceReceiptVerificationRow[];
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
    const row = this.findEventFormationSourceStatement.get(source.source_id) as EventLogRow | undefined;
    if (row === undefined || row.workspace_id !== workspaceId) {
      throw new StorageError("NOT_FOUND", `Formation EventLog source ${source.source_id} is unavailable.`);
    }
    if (digestRelationFormationEventSource(parseEventLogEntryRow(row)) !== source.source_sha256) {
      throw new StorageError("CONFLICT", `Formation EventLog source ${source.source_id} digest does not match.`);
    }
  }

  private verifyHqFormationSource(
    workspaceId: string,
    source: RelationFormationSourceObservation,
    receiptByEvidenceId: ReadonlyMap<string, RelationAssertionEvidenceReceipt>
  ): void {
    const row = this.findHqFormationSourceStatement.get(source.source_id) as HqFormationSourceRow | undefined;
    if (row === undefined || row.workspace_id !== workspaceId) {
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
      const row = this.db.connection.prepare(`
        SELECT resolution_id, assertion_id, workspace_id, resolution_event_id,
               resolution_kind, resolved_at, reason
        FROM relation_assertion_resolution_current
        WHERE assertion_id = ?
        LIMIT 1
      `).get(assertionId) as ResolutionRow | undefined;
      return row === undefined ? null : parseResolutionRow(row);
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
      const rows = this.db.connection.prepare(`
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
      `).all() as AssertionRow[];
      return Object.freeze(rows.map(parseAssertionRow));
    } catch (error) {
      throw wrapRelationAssertionStorageError("list relation assertions", error);
    }
  }

  public listCurrentResolutionsInCurrentTransaction(): readonly Readonly<RelationAssertionResolution>[] {
    try {
      const rows = this.db.connection.prepare(`
        SELECT resolution_id, assertion_id, workspace_id, resolution_event_id,
               resolution_kind, resolved_at, reason
        FROM relation_assertion_resolution_current
        ORDER BY resolved_at ASC, resolution_id ASC
      `).all() as ResolutionRow[];
      return Object.freeze(rows.map(parseResolutionRow));
    } catch (error) {
      throw wrapRelationAssertionStorageError("list relation assertion resolutions", error);
    }
  }

  public writeProjectionGenerationInCurrentTransaction(
    generation: RelationAssertionProjectionGeneration,
    options: { readonly activate: boolean }
  ): void {
    writeProjectionGeneration(this.db, generation, options);
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

function verifyEvidenceReceipt(
  workspaceId: string,
  receipt: RelationAssertionEvidenceReceipt,
  row: EvidenceReceiptVerificationRow | undefined
): void {
  if (row === undefined || row.workspace_id !== workspaceId) {
    throw new StorageError(
      "NOT_FOUND",
      `Evidence ${receipt.evidence_id} is not available in the assertion workspace.`
    );
  }
  if (row.verified_source_event_id === null) {
    throw new StorageError(
      "NOT_FOUND",
      `Evidence ${receipt.evidence_id} source EventLog entry is unavailable.`
    );
  }
  const eventAnchor = parsePersistedEventAnchor(row.event_anchor);
  const expected = receipt.source_event_anchor;
  if (
    eventAnchor === null ||
    eventAnchor.event_type !== expected.event_type ||
    eventAnchor.event_id !== expected.event_id ||
    eventAnchor.occurred_at !== expected.occurred_at
  ) {
    throw new StorageError(
      "CONFLICT",
      `Evidence ${receipt.evidence_id} is not anchored to its admitted source EventLog observation.`
    );
  }
}

function parsePersistedEventAnchor(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function matchesHqSourceReceipt(
  source: HqFormationSourceRow,
  receipt: RelationAssertionEvidenceReceipt
): boolean {
  const anchor = receipt.source_event_anchor;
  return source.source_event_type === anchor.event_type &&
    source.source_event_id === anchor.event_id &&
    source.source_occurred_at === anchor.occurred_at;
}
