import { PathRelationSchema, type PathRelation } from "@do-soul/alaya-protocol";
import { StorageError } from "../../../../shared/errors.js";
import type { StorageDatabase } from "../../../../sqlite/db.js";
import { wrapRelationAssertionStorageError } from "../../relation-assertion-repo-support.js";
import {
  isCompatibleProjectionIdentity,
  type ProjectionIdentity
} from "../../../../sqlite/projection-identity.js";
import type { RelationAssertionProjectionGeneration } from "../../relation-assertion/projection-types.js";

type StoredGeneration = ProjectionIdentity & Readonly<{
  readonly generation: string;
  readonly as_of: string;
  readonly history_digest: string;
}>;

type ResolvedGeneration = Readonly<{
  readonly generation: string;
  readonly projectionCount: number;
  readonly projectionDigest: string;
}>;

export function markProjectionRefreshRequired(db: StorageDatabase): void {
  try {
    const updated = db.connection.prepare(`
      UPDATE temporal_schema_state
      SET projection_refresh_required = 1
      WHERE state_id = 1
    `).run();
    if (updated.changes !== 1) {
      throw new StorageError(
        "CONFLICT",
        "Temporal schema state is missing during projection invalidation."
      );
    }
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw wrapRelationAssertionStorageError("invalidate relation projection", error);
  }
}

export function writeProjectionGeneration(
  db: StorageDatabase,
  generation: RelationAssertionProjectionGeneration,
  options: { readonly activate: boolean }
): string {
  const projections = generation.projections.map((projection) =>
    PathRelationSchema.parse(projection)
  );
  try {
    const schemaOperator = readSchemaHistoryDigest(db);
    if (!options.activate && generation.historyDigest !== schemaOperator) {
      throw new StorageError(
        "CONFLICT",
        "Historical projection witness does not match the live schema operator."
      );
    }
    const resolvedGeneration = resolveProjectionGeneration(db, generation, projections);
    if (options.activate) {
      activateProjectionGeneration(db, {
        ...generation,
        generation: resolvedGeneration.generation,
        projectionDigest: resolvedGeneration.projectionDigest
      }, resolvedGeneration.projectionCount);
    }
    pruneUnreadableProjectionHistories(db, readSchemaHistoryDigest(db));
    return resolvedGeneration.generation;
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw wrapRelationAssertionStorageError("replace active relation projection", error);
  }
}

function readSchemaHistoryDigest(db: StorageDatabase): string {
  const row = db.connection.prepare(`
    SELECT history_digest
    FROM temporal_schema_state
    WHERE state_id = 1
  `).get() as Readonly<{ readonly history_digest: string }> | undefined;
  if (row === undefined) {
    throw new StorageError("CONFLICT", "Temporal schema state is missing.");
  }
  return row.history_digest;
}

function pruneUnreadableProjectionHistories(
  db: StorageDatabase,
  currentHistoryDigest: string
): void {
  // Readers reject generations from any superseded assertion history.
  db.connection.prepare(`
    DELETE FROM temporal_projection_generations
    WHERE history_digest <> ?
      AND generation <> (
        SELECT active_projection_generation
        FROM temporal_schema_state
        WHERE state_id = 1
      )
  `).run(currentHistoryDigest);
}

function resolveProjectionGeneration(
  db: StorageDatabase,
  generation: RelationAssertionProjectionGeneration,
  projections: readonly Readonly<PathRelation>[]
): ResolvedGeneration {
  const incoming = incomingIdentity(generation, projections);
  const byBindKey = findVerifiedBindKey(db, generation.asOf, generation.historyDigest);
  if (byBindKey !== undefined) {
    assertCompatibleStoredGeneration(byBindKey, generation, incoming);
    return resolvedGeneration(byBindKey);
  }
  const byId = findGenerationById(db, generation.generation);
  if (byId !== undefined) {
    if (byId.as_of !== generation.asOf || byId.history_digest !== generation.historyDigest) {
      throw new StorageError(
        "CONFLICT",
        `Projection generation ${generation.generation} already exists with a different as-of or history.`
      );
    }
    assertCompatibleStoredGeneration(byId, generation, incoming);
    return resolvedGeneration(byId);
  }
  insertProjectionGeneration(db, generation, projections);
  return {
    generation: generation.generation,
    projectionCount: projections.length,
    projectionDigest: generation.projectionDigest
  };
}

function resolvedGeneration(generation: StoredGeneration): ResolvedGeneration {
  return {
    generation: generation.generation,
    projectionCount: generation.projection_count,
    projectionDigest: generation.projection_digest
  };
}

function findVerifiedBindKey(
  db: StorageDatabase,
  asOf: string,
  historyDigest: string
): StoredGeneration | undefined {
  return db.connection.prepare(`
    SELECT generation, as_of, history_digest, projection_count, projection_digest,
           assertion_schema_generation, assertion_event_contract_generation,
           projection_schema_generation, projection_policy_id, projection_policy_sha256
    FROM temporal_projection_generations
    WHERE as_of = ? AND history_digest = ? AND status = 'verified'
  `).get(asOf, historyDigest) as StoredGeneration | undefined;
}

function findGenerationById(
  db: StorageDatabase,
  generation: string
): StoredGeneration | undefined {
  return db.connection.prepare(`
    SELECT generation, as_of, history_digest, projection_count, projection_digest,
           assertion_schema_generation, assertion_event_contract_generation,
           projection_schema_generation, projection_policy_id, projection_policy_sha256
    FROM temporal_projection_generations
    WHERE generation = ?
  `).get(generation) as StoredGeneration | undefined;
}

function incomingIdentity(
  generation: RelationAssertionProjectionGeneration,
  projections: readonly Readonly<PathRelation>[]
): ProjectionIdentity {
  return {
    projection_count: projections.length,
    projection_digest: generation.projectionDigest,
    assertion_schema_generation: generation.assertionSchemaGeneration,
    assertion_event_contract_generation: generation.assertionEventContractGeneration,
    projection_schema_generation: generation.projectionSchemaGeneration,
    projection_policy_id: generation.projectionPolicyId,
    projection_policy_sha256: generation.projectionPolicySha256
  };
}

function assertCompatibleStoredGeneration(
  existing: StoredGeneration,
  generation: RelationAssertionProjectionGeneration,
  incoming: ProjectionIdentity
): void {
  if (!isCompatibleProjectionIdentity(existing, incoming)) {
    throw new StorageError(
      "CONFLICT",
      `Projection generation ${generation.generation} already exists with a different digest.`
    );
  }
}

function insertProjectionGeneration(
  db: StorageDatabase,
  generation: RelationAssertionProjectionGeneration,
  projections: readonly Readonly<PathRelation>[]
): void {
  db.connection.prepare(`
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
  insertPathProjections(db, generation.generation, projections);
}

function insertPathProjections(
  db: StorageDatabase,
  generation: string,
  projections: readonly Readonly<PathRelation>[]
): void {
  const statement = db.connection.prepare(`
    INSERT INTO relation_path_projections (
      generation, path_id, assertion_id, workspace_id, projection_json
    ) VALUES (?, ?, ?, ?, ?)
  `);
  for (const projection of projections) {
    statement.run(
      generation,
      projection.path_id,
      projection.path_id,
      projection.workspace_id,
      JSON.stringify(projection)
    );
  }
}

function activateProjectionGeneration(
  db: StorageDatabase,
  generation: RelationAssertionProjectionGeneration,
  projectionCount: number
): void {
  const updated = db.connection.prepare(`
    UPDATE temporal_schema_state
    SET assertion_schema_generation = ?, assertion_event_contract_generation = ?,
        projection_schema_generation = ?, active_projection_generation = ?, active_as_of = ?,
        projection_policy_id = ?, projection_policy_sha256 = ?, history_digest = ?,
        projection_count = ?, projection_digest = ?, status = 'ready',
        projection_refresh_required = 0, updated_at = ?
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
    projectionCount,
    generation.projectionDigest,
    generation.createdAt
  );
  if (updated.changes !== 1) {
    throw new StorageError(
      "CONFLICT",
      "Temporal schema state is missing during projection activation."
    );
  }
}
