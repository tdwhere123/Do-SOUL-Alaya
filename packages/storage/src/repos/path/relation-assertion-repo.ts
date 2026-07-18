import {
  PathRelationSchema,
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
  parseRelationAssertionJsonArray,
  requireUniqueRelationAssertionEvidenceIds,
  wrapRelationAssertionStorageError
} from "./relation-assertion-repo-support.js";

export type RelationAssertionProjectionGeneration = Readonly<{
  readonly generation: string;
  readonly assertionSchemaGeneration: string;
  readonly assertionEventContractGeneration: string;
  readonly projectionSchemaGeneration: string;
  readonly projectionPolicyId: string;
  readonly projectionPolicySha256: string;
  readonly historyDigest: string;
  readonly asOf: string;
  readonly projectionDigest: string;
  readonly projections: readonly Readonly<PathRelation>[];
  readonly createdAt: string;
}>;

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
type AssertionRow = Readonly<{
  readonly assertion_id: string;
  readonly workspace_id: string;
  readonly admission_event_id: string;
  readonly anchors_json: string;
  readonly relation_kind: string;
  readonly validity_json: string;
  readonly admitted_at: string;
  readonly evidence_ids_json: string;
}>;
type ResolutionRow = Readonly<{
  readonly resolution_id: string;
  readonly assertion_id: string;
  readonly workspace_id: string;
  readonly resolution_event_id: string;
  readonly resolution_kind: string;
  readonly resolved_at: string;
  readonly reason: string;
}>;
type ProjectionRow = Readonly<{ readonly projection_json: string }>;

export class SqliteRelationAssertionRepo implements RelationAssertionRepo {
  public constructor(private readonly db: StorageDatabase) {}

  public getStorageConnectionIdentity(): StorageDatabase {
    return this.db;
  }

  public readActiveProjectionGenerationInCurrentTransaction(): string | null {
    try {
      const row = this.db.connection.prepare(`
        SELECT active_projection_generation
        FROM temporal_schema_state
        WHERE state_id = 1 AND status = 'ready'
        LIMIT 1
      `).get() as Readonly<{ readonly active_projection_generation: string | null }> | undefined;
      return row?.active_projection_generation ?? null;
    } catch (error) {
      throw wrapRelationAssertionStorageError("read active projection generation", error);
    }
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
    const projections = generation.projections.map((projection) => PathRelationSchema.parse(projection));
    try {
      const existing = this.db.connection.prepare(`
        SELECT projection_count, projection_digest
        FROM temporal_projection_generations
        WHERE generation = ?
        LIMIT 1
      `).get(generation.generation) as
        | Readonly<{ readonly projection_count: number; readonly projection_digest: string }>
        | undefined;
      if (existing === undefined) {
        this.db.connection.prepare(`
          INSERT INTO temporal_projection_generations (
            generation, assertion_schema_generation, assertion_event_contract_generation,
            projection_schema_generation, projection_policy_id, projection_policy_sha256,
            history_digest, as_of, projection_count, projection_digest, status,
            created_at, verified_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified', ?, ?)
        `).run(
          generation.generation,
          generation.assertionSchemaGeneration,
          generation.assertionEventContractGeneration,
          generation.projectionSchemaGeneration,
          generation.projectionPolicyId,
          generation.projectionPolicySha256,
          generation.historyDigest,
          generation.asOf,
          projections.length,
          generation.projectionDigest,
          generation.createdAt,
          generation.createdAt
        );
        const insertProjection = this.db.connection.prepare(`
          INSERT INTO relation_path_projections (
            generation, path_id, assertion_id, workspace_id, projection_json
          ) VALUES (?, ?, ?, ?, ?)
        `);
        for (const projection of projections) {
          insertProjection.run(
            generation.generation,
            projection.path_id,
            projection.path_id,
            projection.workspace_id,
            JSON.stringify(projection)
          );
        }
      } else if (
        existing.projection_count !== projections.length ||
        existing.projection_digest !== generation.projectionDigest
      ) {
        throw new StorageError(
          "CONFLICT",
          `Projection generation ${generation.generation} already exists with a different digest.`
        );
      }
      if (!options.activate) return;
      const updated = this.db.connection.prepare(`
        UPDATE temporal_schema_state
        SET assertion_schema_generation = ?, assertion_event_contract_generation = ?,
            projection_schema_generation = ?, active_projection_generation = ?, active_as_of = ?,
            projection_policy_id = ?, projection_policy_sha256 = ?, history_digest = ?,
            projection_count = ?, projection_digest = ?, status = 'ready', updated_at = ?
        WHERE state_id = 1
      `).run(
        generation.assertionSchemaGeneration,
        generation.assertionEventContractGeneration,
        generation.projectionSchemaGeneration,
        generation.generation,
        generation.asOf,
        generation.projectionPolicyId,
        generation.projectionPolicySha256,
        generation.historyDigest,
        projections.length,
        generation.projectionDigest,
        generation.createdAt
      );
      if (updated.changes !== 1) {
        throw new StorageError("CONFLICT", "Temporal schema state is missing during projection activation.");
      }
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw wrapRelationAssertionStorageError("replace active relation projection", error);
    }
  }

  public async findActiveProjectionByWorkspace(
    workspaceId: string
  ): Promise<readonly Readonly<PathRelation>[]> {
    try {
      const rows = this.db.connection.prepare(`
        SELECT projection_json
        FROM relation_path_projections
        WHERE generation = (
          SELECT active_projection_generation
          FROM temporal_schema_state
          WHERE state_id = 1 AND status = 'ready'
        )
          AND workspace_id = ?
        ORDER BY path_id ASC
      `).all(workspaceId) as ProjectionRow[];
      return Object.freeze(rows.map(parseProjectionRow));
    } catch (error) {
      throw wrapRelationAssertionStorageError("read active relation projections", error);
    }
  }

  public async findActiveProjectionById(pathId: string): Promise<Readonly<PathRelation> | null> {
    try {
      const row = this.db.connection.prepare(`
        SELECT projection_json
        FROM relation_path_projections
        WHERE generation = (
          SELECT active_projection_generation
          FROM temporal_schema_state
          WHERE state_id = 1 AND status = 'ready'
        )
          AND path_id = ?
        LIMIT 1
      `).get(pathId) as ProjectionRow | undefined;
      return row === undefined ? null : parseProjectionRow(row);
    } catch (error) {
      throw wrapRelationAssertionStorageError("read active relation projection", error);
    }
  }

  public async findProjectionByWorkspaceAtAsOf(
    workspaceId: string,
    asOf: string
  ): Promise<readonly Readonly<PathRelation>[] | null> {
    try {
      // Historical projections are caches: only the generation built from the
      // currently verified assertion/resolution history may serve a read.
      const generation = this.db.connection.prepare(`
        SELECT generation
        FROM temporal_projection_generations
        WHERE as_of = ?
          AND history_digest = (
            SELECT history_digest
            FROM temporal_schema_state
            WHERE state_id = 1 AND status = 'ready'
          )
          AND status = 'verified'
        LIMIT 1
      `).get(asOf) as Readonly<{ readonly generation: string }> | undefined;
      if (generation === undefined) return null;
      const rows = this.db.connection.prepare(`
        SELECT projection_json
        FROM relation_path_projections
        WHERE generation = ? AND workspace_id = ?
        ORDER BY path_id ASC
      `).all(generation.generation, workspaceId) as ProjectionRow[];
      return Object.freeze(rows.map(parseProjectionRow));
    } catch (error) {
      throw wrapRelationAssertionStorageError("read relation projection at as-of", error);
    }
  }
}

function parseAssertionRow(row: AssertionRow): Readonly<RelationAssertion> {
  return RelationAssertionSchema.parse({
    assertion_id: row.assertion_id,
    workspace_id: row.workspace_id,
    admission_event_id: row.admission_event_id,
    evidence_ids: parseRelationAssertionJsonArray(row.evidence_ids_json, "relation assertion evidence"),
    anchors: parseRelationAssertionJson(row.anchors_json, "relation assertion anchors"),
    relation_kind: row.relation_kind,
    validity: parseRelationAssertionJson(row.validity_json, "relation assertion validity"),
    admitted_at: row.admitted_at
  });
}

function parseResolutionRow(row: ResolutionRow): Readonly<RelationAssertionResolution> {
  return RelationAssertionResolutionSchema.parse({
    resolution_id: row.resolution_id,
    assertion_id: row.assertion_id,
    workspace_id: row.workspace_id,
    event_id: row.resolution_event_id,
    resolution_kind: row.resolution_kind,
    resolved_at: row.resolved_at,
    reason: row.reason
  });
}

function parseProjectionRow(row: ProjectionRow): Readonly<PathRelation> {
  return PathRelationSchema.parse(parseRelationAssertionJson(row.projection_json, "relation path projection"));
}
