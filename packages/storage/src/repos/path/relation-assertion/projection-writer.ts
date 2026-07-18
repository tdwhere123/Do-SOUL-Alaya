import { PathRelationSchema, type PathRelation } from "@do-soul/alaya-protocol";
import { StorageError } from "../../../shared/errors.js";
import type { StorageDatabase } from "../../../sqlite/db.js";
import { wrapRelationAssertionStorageError } from "../relation-assertion-repo-support.js";
import type { RelationAssertionProjectionGeneration } from "./projection-types.js";

type ExistingGeneration = Readonly<{
  readonly projection_count: number;
  readonly projection_digest: string;
}>;

export function writeProjectionGeneration(
  db: StorageDatabase,
  generation: RelationAssertionProjectionGeneration,
  options: { readonly activate: boolean }
): void {
  const projections = generation.projections.map((projection) =>
    PathRelationSchema.parse(projection)
  );
  try {
    ensureProjectionGeneration(db, generation, projections);
    if (options.activate) activateProjectionGeneration(db, generation, projections.length);
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw wrapRelationAssertionStorageError("replace active relation projection", error);
  }
}

function ensureProjectionGeneration(
  db: StorageDatabase,
  generation: RelationAssertionProjectionGeneration,
  projections: readonly Readonly<PathRelation>[]
): void {
  const existing = db.connection.prepare(`
    SELECT projection_count, projection_digest
    FROM temporal_projection_generations
    WHERE generation = ?
    LIMIT 1
  `).get(generation.generation) as ExistingGeneration | undefined;
  if (existing === undefined) {
    insertProjectionGeneration(db, generation, projections);
    return;
  }
  if (
    existing.projection_count !== projections.length ||
    existing.projection_digest !== generation.projectionDigest
  ) {
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
