import {
  RelationAssertionResolutionSchema,
  RelationAssertionSchema,
  type PathRelation,
  type RelationAssertion,
  type RelationAssertionResolution
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";
import {
  parseRelationAssertionJson,
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
import {
  parseAssertionRow,
  parseResolutionRow,
  type AssertionRow,
  type ResolutionRow
} from "./relation-assertion/row-mappers.js";

export type { RelationAssertionProjectionGeneration } from "./relation-assertion/projection-types.js";

export type RelationAssertionEvidenceAnchor = Readonly<{
  readonly eventType: string;
  readonly eventId: string;
  readonly occurredAt: string;
}>;

export interface RelationAssertionRepo {
  getStorageConnectionIdentity(): object;
  readActiveProjectionGenerationInCurrentTransaction(): string | null;
  getByIdInCurrentTransaction(assertionId: string): Readonly<RelationAssertion> | null;
  findByIdentityKeyInCurrentTransaction(identityKey: string): Readonly<RelationAssertion> | null;
  createInCurrentTransaction(input: {
    readonly assertion: RelationAssertion;
    readonly identityKey: string;
  }): Readonly<RelationAssertion>;
  assertEvidenceAnchorsInCurrentTransaction(input: {
    readonly workspaceId: string;
    readonly evidenceIds: readonly string[];
    readonly sourceAnchor: RelationAssertionEvidenceAnchor;
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
  public constructor(private readonly db: StorageDatabase) {}

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
               validity_json, admitted_at,
               (SELECT json_group_array(evidence_id)
                  FROM relation_assertion_evidence
                 WHERE assertion_id = relation_assertions.assertion_id
                 ORDER BY evidence_id ASC) AS evidence_ids_json
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
               validity_json, admitted_at,
               (SELECT json_group_array(evidence_id)
                  FROM relation_assertion_evidence
                 WHERE assertion_id = relation_assertions.assertion_id
                 ORDER BY evidence_id ASC) AS evidence_ids_json
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
    const evidenceIds = requireUniqueRelationAssertionEvidenceIds(assertion.evidence_ids);
    try {
      this.db.connection.prepare(`
        INSERT INTO relation_assertions (
          assertion_id, workspace_id, admission_event_id, identity_key,
          anchors_json, relation_kind, validity_json, admitted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        assertion.assertion_id,
        assertion.workspace_id,
        assertion.admission_event_id,
        input.identityKey,
        JSON.stringify(assertion.anchors),
        assertion.relation_kind,
        JSON.stringify(assertion.validity),
        assertion.admitted_at
      );
      const insertEvidence = this.db.connection.prepare(`
        INSERT INTO relation_assertion_evidence (assertion_id, evidence_id)
        VALUES (?, ?)
      `);
      for (const evidenceId of evidenceIds) {
        insertEvidence.run(assertion.assertion_id, evidenceId);
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

  public assertEvidenceAnchorsInCurrentTransaction(input: {
    readonly workspaceId: string;
    readonly evidenceIds: readonly string[];
    readonly sourceAnchor: RelationAssertionEvidenceAnchor;
  }): void {
    const evidenceIds = requireUniqueRelationAssertionEvidenceIds(input.evidenceIds);
    try {
      const statement = this.db.connection.prepare(`
        SELECT object_id, workspace_id, event_anchor
        FROM evidence_capsules
        WHERE object_id = ?
        LIMIT 1
      `);
      for (const evidenceId of evidenceIds) {
        const row = statement.get(evidenceId) as
          | Readonly<{ readonly object_id: string; readonly workspace_id: string; readonly event_anchor: string | null }>
          | undefined;
        if (row === undefined || row.workspace_id !== input.workspaceId) {
          throw new StorageError("NOT_FOUND", `Evidence ${evidenceId} is not available in the assertion workspace.`);
        }
        const eventAnchor = row.event_anchor === null
          ? null
          : parseRelationAssertionJson(row.event_anchor, "evidence event anchor") as Record<string, unknown>;
        if (
          eventAnchor === null ||
          eventAnchor.event_type !== input.sourceAnchor.eventType ||
          eventAnchor.event_id !== input.sourceAnchor.eventId ||
          eventAnchor.occurred_at !== input.sourceAnchor.occurredAt
        ) {
          throw new StorageError(
            "CONFLICT",
            `Evidence ${evidenceId} is not anchored to the admitted source EventLog observation.`
          );
        }
      }
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw wrapRelationAssertionStorageError("verify relation assertion evidence anchors", error);
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
               validity_json, admitted_at,
               (SELECT json_group_array(evidence_id)
                  FROM relation_assertion_evidence
                 WHERE assertion_id = relation_assertions.assertion_id
                 ORDER BY evidence_id ASC) AS evidence_ids_json
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
