import {
  serializePathAnchorRef,
  type PathAnchorRef,
  type PathRelation
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../../sqlite/db.js";
import { StorageError } from "../../../shared/errors.js";
import {
  parsePathRelation,
  parsePathRelationRow,
  type PathRelationRow
} from "../path-relation-rows.js";
import { PATH_RELATION_SELECT_COLUMNS } from "../path-relation-sql.js";

export type SoftAssociationPathReadOptions = Readonly<{ readonly asOf?: string }>;

export class SqliteSoftAssociationPathRepo {
  private readonly insert;
  private readonly selectCurrent;
  private readonly selectHistorical;

  public constructor(private readonly database: StorageDatabase) {
    this.insert = database.connection.prepare(`
      INSERT INTO soft_association_path_relations (
        path_id, workspace_id, anchors_json, constitution_json,
        effect_vector_json, plasticity_state_json, lifecycle_json,
        legitimacy_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.selectCurrent = database.connection.prepare(`
      SELECT${PATH_RELATION_SELECT_COLUMNS}
      FROM soft_association_path_relations
      WHERE workspace_id = ?
      ORDER BY created_at ASC, path_id ASC
    `);
    this.selectHistorical = database.connection.prepare(`
      SELECT${PATH_RELATION_SELECT_COLUMNS}
      FROM soft_association_path_relations
      WHERE workspace_id = ? AND created_at <= ? AND updated_at <= ?
      ORDER BY created_at ASC, path_id ASC
    `);
  }

  public create(relation: PathRelation): Readonly<PathRelation> {
    const parsed = parsePathRelation(relation);
    assertCanonicalSoftAssociation(parsed);
    try {
      this.insert.run(
        parsed.path_id,
        parsed.workspace_id,
        JSON.stringify(parsed.anchors),
        JSON.stringify(parsed.constitution),
        JSON.stringify(parsed.effect_vector),
        JSON.stringify(parsed.plasticity_state),
        JSON.stringify(parsed.lifecycle),
        JSON.stringify(parsed.legitimacy),
        parsed.created_at,
        parsed.updated_at
      );
      return parsed;
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to insert soft association path ${parsed.path_id}.`,
        error
      );
    }
  }

  public async findByAnchors(
    workspaceId: string,
    anchors: readonly PathAnchorRef[],
    options: SoftAssociationPathReadOptions = {}
  ): Promise<readonly Readonly<PathRelation>[]> {
    if (anchors.length === 0) return Object.freeze([]);
    const keys = new Set(anchors.map(serializePathAnchorRef));
    const paths = await this.findActiveByWorkspace(workspaceId, options);
    return Object.freeze(paths.filter((path) =>
      keys.has(serializePathAnchorRef(path.anchors.source_anchor)) ||
      keys.has(serializePathAnchorRef(path.anchors.target_anchor))
    ));
  }

  public async findActiveByWorkspace(
    workspaceId: string,
    options: SoftAssociationPathReadOptions = {}
  ): Promise<readonly Readonly<PathRelation>[]> {
    const asOf = options.asOf === undefined
      ? undefined
      : normalizeHistoricalAsOf(options.asOf);
    try {
      const rows = asOf === undefined
        ? this.selectCurrent.all(workspaceId)
        : this.selectHistorical.all(workspaceId, asOf, asOf);
      return Object.freeze((rows as readonly PathRelationRow[]).map(parsePathRelationRow));
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to read soft association paths.", error);
    }
  }

  public async findByBackingObjectId(
    workspaceId: string,
    objectId: string
  ): Promise<readonly Readonly<PathRelation>[]> {
    return await this.findByAnchors(workspaceId, [{ kind: "object", object_id: objectId }]);
  }
}

function normalizeHistoricalAsOf(asOf: string): string {
  const parsed = Date.parse(asOf);
  if (!Number.isFinite(parsed)) {
    throw new StorageError("VALIDATION_FAILED", "Soft association asOf must be valid.");
  }
  return new Date(parsed).toISOString();
}

function assertCanonicalSoftAssociation(path: Readonly<PathRelation>): void {
  const basis = path.legitimacy.evidence_basis;
  if (
    path.constitution.relation_kind !== "co_recalled" ||
    path.anchors.source_anchor.kind !== "object" ||
    path.anchors.target_anchor.kind !== "object" ||
    path.effect_vector.recall_bias <= 0 ||
    path.lifecycle.status !== "active" ||
    path.legitimacy.governance_class !== "attention_only" ||
    basis.length !== 1 ||
    basis[0] !== "recalls_edge_co_usage"
  ) {
    throw new StorageError(
      "VALIDATION_FAILED",
      "Soft association paths require the canonical co-recalled usage profile."
    );
  }
}
