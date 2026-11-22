import {
  RelationAssertionResolutionSchema,
  RelationAssertionResolvedPayloadSchema,
  RelationAssertionSchema,
  type PathRelation,
  type RelationAssertion,
  type RelationAssertionResolution
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";
import { parseOptionalRow, parseRows } from "../shared/parse-row.js";
import { EventLogEntryRowParser } from "../runtime/event-log/mappers/event-log-rows.js";
import {
  requireUniqueRelationAssertionEvidenceIds,
  wrapRelationAssertionStorageError
} from "./relation-assertion-repo-support.js";
import {
  findActiveProjectionById,
  findActiveProjectionByWorkspace,
  findProjectionByWorkspaceAtAsOf,
  readActiveProjectionGeneration,
  readCurrentHistoryDigest,
  readReadableProjectionHistoryDigest
} from "./reads/relation-assertion/projection-reader.js";
import type { RelationAssertionProjectionGeneration } from "./relation-assertion/projection-types.js";
import {
  markProjectionRefreshRequired,
  writeProjectionGeneration
} from "./writes/relation-assertion/projection-writer.js";
import { SqliteRelationFormationInputs, type RelationFormationInputs } from "./relation-assertion/relation-formation-inputs.js";
import {
  AssertionRowParser,
  ResolutionRowParser
} from "./mappers/relation-assertion/row-mappers.js";

export type { RelationAssertionProjectionGeneration } from "./relation-assertion/projection-types.js";

export interface RelationAssertionRepo {
  getStorageConnectionIdentity(): object;
  readActiveProjectionGenerationInCurrentTransaction(): string | null;
  readCurrentHistoryDigestInCurrentTransaction(): string | null;
  readReadableProjectionHistoryDigest(): string | null;
  getByIdInCurrentTransaction(assertionId: string): Readonly<RelationAssertion> | null;
  findByIdentityKeyInCurrentTransaction(identityKey: string): Readonly<RelationAssertion> | null;
  createInCurrentTransaction(input: {
    readonly assertion: RelationAssertion;
    readonly identityKey: string;
  }): Readonly<RelationAssertion>;
  markProjectionRefreshRequiredInCurrentTransaction(): void;
  hasErasedFormationSourceInCurrentTransaction(assertion: Readonly<RelationAssertion>): boolean;
  assertFormationInputsInCurrentTransaction(input: RelationFormationInputs): void;
  getCurrentResolutionInCurrentTransaction(
    assertionId: string
  ): Readonly<RelationAssertionResolution> | null;
  createCurrentResolutionInCurrentTransaction(
    resolution: RelationAssertionResolution
  ): Readonly<RelationAssertionResolution>;
  listAssertionsInCurrentTransaction(): readonly Readonly<RelationAssertion>[];
  listCurrentResolutionsInCurrentTransaction(): readonly Readonly<RelationAssertionResolution>[];
  listResolutionHistoryInCurrentTransaction(): readonly Readonly<RelationAssertionResolution>[];
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
  private readonly formationInputs: SqliteRelationFormationInputs;

  public constructor(private readonly db: StorageDatabase) {
    this.formationInputs = new SqliteRelationFormationInputs(db);
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

  public readReadableProjectionHistoryDigest(): string | null {
    return readReadableProjectionHistoryDigest(this.db);
  }

  public hasErasedFormationSourceInCurrentTransaction(assertion: Readonly<RelationAssertion>): boolean {
    return this.formationInputs.hasErasedSource(assertion.workspace_id, assertion.evidence_receipts);
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

  public assertFormationInputsInCurrentTransaction(input: RelationFormationInputs): void {
    this.formationInputs.verify(input);
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
        ON CONFLICT(assertion_id) DO UPDATE SET
          resolution_id = excluded.resolution_id, workspace_id = excluded.workspace_id,
          resolution_event_id = excluded.resolution_event_id, resolution_kind = excluded.resolution_kind,
          resolved_at = excluded.resolved_at, reason = excluded.reason
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

  public listResolutionHistoryInCurrentTransaction(): readonly Readonly<RelationAssertionResolution>[] {
    const events = parseRows(this.db.connection.prepare(`
      SELECT * FROM event_log
      WHERE event_type = 'relation.assertion_resolved'
      ORDER BY revision ASC, event_id ASC
    `).all(), EventLogEntryRowParser, "relation resolution history row");
    return Object.freeze(events.map(event => {
      const parsed = RelationAssertionResolvedPayloadSchema.safeParse(event.payload_json);
      if (!parsed.success) {
        throw new StorageError("CONFLICT", "Relation assertion resolution EventLog payload is not canonical.");
      }
      const payload = parsed.data;
      if (event.entity_type !== "relation_assertion" || event.entity_id !== payload.assertion_id ||
          event.workspace_id !== payload.workspace_id) {
        throw new StorageError("CONFLICT", "Relation resolution history identity is not canonical.");
      }
      return RelationAssertionResolutionSchema.parse({ ...payload, event_id: event.event_id });
    }));
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
