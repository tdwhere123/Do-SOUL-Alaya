import {
  type EvidenceCapsule,
  type EvidenceFactFrameFormationCapture,
  type EvidenceSearchProjection,
  type EvidenceHealthState
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { RefreshableStatementHolder } from "../../sqlite/refreshable-statement-holder.js";
import { StorageError } from "../../shared/errors.js";
import { toFieldSearchStorageError } from "../shared/field-search-errors.js";
import {
  searchEvidenceByKeyword,
  searchEvidenceByKeywordField
} from "./evidence-search/evidence-keyword-search.js";
import type {
  EvidenceCapsuleKeywordHit,
  EvidenceSearchMatch,
  RecallQualifiedEvidence
} from "./evidence-recall-types.js";
import {
  DEFAULT_EVIDENCE_PAGE,
  parseEvidenceCapsule,
  parseEvidenceCapsulePage,
  parseEvidenceCapsuleRow,
  parseEvidenceHealthState,
  parseUpdatedAt,
  type EvidenceCapsuleRow
} from "./evidence-capsule-mappers.js";
import {
  prepareEvidenceCapsuleStatements,
  type EvidenceCapsuleStatements
} from "./evidence-capsule-statements.js";
import { RecallQualifiedEvidenceReader } from "./recall-qualified-evidence-reader.js";
import { prepareFactFrameFormationInsert } from
  "./fact-frame-formation/capture-store.js";
import { EvidenceProjectionIntegrityError } from
  "./qualification/qualified-evidence-projection.js";
import type {
  EvidenceCapsuleListPageOptions,
  EvidenceCapsuleRepo,
  EvidenceSourceAnchor
} from "./evidence-capsule-repo-port.js";

export type {
  EvidenceCapsuleListPageOptions,
  EvidenceCapsuleRepo,
  EvidenceSourceAnchor
} from "./evidence-capsule-repo-port.js";

export type {
  EvidenceCapsuleKeywordHit,
  EvidenceSearchMatch,
  EvidenceSearchProjectionIdentity,
  RecallQualifiedEvidence
} from "./evidence-recall-types.js";

interface FactKeyProjectionIdentityRow {
  readonly object_id: string;
  readonly projection_id: number;
  readonly projection_kind: "fact_key";
}

interface EvidenceSourceAnchorRow {
  readonly evidence_object_id: string;
  readonly artifact_ref: string | null;
}

// see also: packages/protocol/src/soul/fts-search-policy.ts — porter/trigram
// split and ordinal-rank merge shared with synthesis-capsule-repo.ts.
export class SqliteEvidenceCapsuleRepo implements EvidenceCapsuleRepo {
  private readonly statementHolder: RefreshableStatementHolder<EvidenceCapsuleStatements>;
  private readonly recallQualifiedReader: RecallQualifiedEvidenceReader;

  public constructor(private readonly db: StorageDatabase) {
    this.statementHolder = new RefreshableStatementHolder(db, prepareEvidenceCapsuleStatements);
    this.recallQualifiedReader = new RecallQualifiedEvidenceReader(db);
  }

  private get statements(): EvidenceCapsuleStatements {
    return this.statementHolder.active();
  }

  private activeConnection(): StorageDatabase["connection"] {
    this.statementHolder.active();
    return this.db.connection;
  }

  public async searchByKeyword(
    workspaceId: string,
    queryText: string,
    limit: number
  ): Promise<readonly EvidenceCapsuleKeywordHit[]> {
    try {
      return searchEvidenceByKeyword(this.statements, workspaceId, queryText, limit);
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to search evidence capsules for workspace ${workspaceId}.`,
        error
      );
    }
  }

  public async searchByKeywordField(
    workspaceId: string,
    queryText: string,
    limit: number,
    refinementDepths: readonly number[] = []
  ) {
    try {
      return this.activeConnection().transaction(() => searchEvidenceByKeywordField(
        this.statements, workspaceId, queryText, limit, refinementDepths
      ))();
    } catch (error) {
      throw toFieldSearchStorageError(
        error,
        `Failed to search evidence field for workspace ${workspaceId}.`
      );
    }
  }

  public async searchManyByKeywordField(
    workspaceId: string,
    queries: readonly Readonly<{
      readonly queryText: string;
      readonly limit: number;
      readonly refinement_depths?: readonly number[];
    }>[]
  ) {
    return await Promise.all(queries.map(({ queryText, limit, refinement_depths }) =>
      this.searchByKeywordField(workspaceId, queryText, limit, refinement_depths)
    ));
  }

  public async create(
    capsule: EvidenceCapsule,
    searchProjections: readonly Readonly<EvidenceSearchProjection>[] = [],
    factFrameFormation?: Readonly<EvidenceFactFrameFormationCapture>
  ): Promise<Readonly<EvidenceCapsule>> {
    const parsedCapsule = parseEvidenceCapsule(capsule);
    const formationInsert = prepareFactFrameFormationInsert(
      parsedCapsule,
      searchProjections,
      factFrameFormation
    );

    try {
      this.db.connection.transaction(() => {
        this.statements.createStatement.run(
          parsedCapsule.object_id,
          parsedCapsule.object_kind,
          parsedCapsule.schema_version,
          parsedCapsule.lifecycle_state,
          parsedCapsule.created_at,
          parsedCapsule.updated_at,
          parsedCapsule.created_by,
          parsedCapsule.evidence_kind,
          JSON.stringify(parsedCapsule.semantic_anchor),
          parsedCapsule.event_anchor === null ? null : JSON.stringify(parsedCapsule.event_anchor),
          parsedCapsule.physical_anchor === null ? null : JSON.stringify(parsedCapsule.physical_anchor),
          parsedCapsule.evidence_health_state,
          parsedCapsule.gist,
          parsedCapsule.excerpt,
          parsedCapsule.source_hash,
          parsedCapsule.run_id,
          parsedCapsule.workspace_id,
          parsedCapsule.surface_id
        );
        for (const projection of searchProjections) {
          this.statements.createSearchProjectionStatement.run(
            parsedCapsule.object_id,
            projection.projection_id,
            projection.projection_kind,
            parsedCapsule.workspace_id,
            parsedCapsule.source_hash,
            projection.content
          );
        }
        if (formationInsert !== null) {
          this.statements.createFactFrameFormationStatement.run(...formationInsert);
        }
      })();
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to create evidence capsule ${parsedCapsule.object_id}.`,
        error
      );
    }

    return parsedCapsule;
  }

  public async deleteById(objectId: string): Promise<void> {
    try {
      this.activeConnection().prepare("DELETE FROM evidence_capsules WHERE object_id = ?").run(objectId);
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to delete evidence capsule ${objectId}.`, error);
    }
  }

  public async findById(objectId: string): Promise<Readonly<EvidenceCapsule> | null> {
    try {
      const row = this.statements.findByIdStatement.get(objectId) as EvidenceCapsuleRow | undefined;
      return row === undefined ? null : parseEvidenceCapsuleRow(row);
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to load evidence capsule ${objectId}.`, error);
    }
  }

  public async findByArtifactRef(
    workspaceId: string,
    artifactRef: string
  ): Promise<Readonly<EvidenceCapsule> | null> {
    try {
      const row = this.statements.findByArtifactRefStatement.get(
        workspaceId,
        artifactRef
      ) as EvidenceCapsuleRow | undefined;
      return row === undefined ? null : parseEvidenceCapsuleRow(row);
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to load evidence capsule by artifact reference in workspace ${workspaceId}.`,
        error
      );
    }
  }

  public async findByIds(
    workspaceId: string,
    objectIds: readonly string[]
  ): Promise<readonly Readonly<EvidenceCapsule>[]> {
    const uniqueIds = [...new Set(objectIds.map((objectId) => objectId.trim()).filter((objectId) => objectId.length > 0))];
    if (uniqueIds.length === 0) {
      return [];
    }

    try {
      const rows: EvidenceCapsuleRow[] = [];
      for (let offset = 0; offset < uniqueIds.length; offset += 500) {
        const chunk = uniqueIds.slice(offset, offset + 500);
        rows.push(...this.statements.findByIdsStatement.all(
          workspaceId,
          JSON.stringify(chunk)
        ) as EvidenceCapsuleRow[]);
      }
      rows.sort((left, right) =>
        left.created_at.localeCompare(right.created_at) || left.object_id.localeCompare(right.object_id)
      );
      return rows.map((row) => parseEvidenceCapsuleRow(row));
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to load evidence capsules by ids.", error);
    }
  }

  public async findRecallQualifiedByIds(
    workspaceId: string,
    matches: readonly EvidenceSearchMatch[]
  ): Promise<readonly RecallQualifiedEvidence[]> {
    try {
      return this.recallQualifiedReader.find(workspaceId, matches);
    } catch (error) {
      if (error instanceof EvidenceProjectionIntegrityError) {
        throw error;
      }
      throw new StorageError(
        "QUERY_FAILED",
        "Failed to load recall-qualified evidence capsules by ids.",
        error
      );
    }
  }

  public async findRecallQualifiedFactKeysByIds(
    workspaceId: string,
    evidenceObjectIds: readonly string[]
  ): Promise<readonly RecallQualifiedEvidence[]> {
    const ids = uniqueNonEmpty(evidenceObjectIds);
    if (ids.length === 0) return [];
    try {
      const matches: EvidenceSearchMatch[] = [];
      for (let offset = 0; offset < ids.length; offset += 500) {
        const rows = this.statements.findFactKeyProjectionIdentitiesByIdsStatement.all(
          workspaceId,
          JSON.stringify(ids.slice(offset, offset + 500))
        ) as FactKeyProjectionIdentityRow[];
        matches.push(...rows.map((row) => Object.freeze({
          object_id: row.object_id,
          matched_projection: Object.freeze({
            projection_id: row.projection_id,
            projection_kind: row.projection_kind
          })
        })));
      }
      return this.recallQualifiedReader.find(workspaceId, matches);
    } catch (error) {
      if (error instanceof EvidenceProjectionIntegrityError) throw error;
      throw new StorageError(
        "QUERY_FAILED",
        "Failed to load recall-qualified fact-key projections.",
        error
      );
    }
  }

  public async findSourceAnchorsByIds(
    workspaceId: string,
    evidenceObjectIds: readonly string[]
  ): Promise<readonly EvidenceSourceAnchor[]> {
    const ids = uniqueNonEmpty(evidenceObjectIds);
    if (ids.length === 0) return [];
    try {
      const rows: EvidenceSourceAnchorRow[] = [];
      for (let offset = 0; offset < ids.length; offset += 500) {
        const chunk = ids.slice(offset, offset + 500);
        rows.push(...this.statements.findSourceAnchorsByIdsStatement.all(
          workspaceId,
          JSON.stringify(chunk)
        ) as EvidenceSourceAnchorRow[]);
      }
      return sortSourceAnchors(rows.filter(
        (row): row is EvidenceSourceAnchor => row.artifact_ref !== null
      ));
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to load evidence source anchors by ids.", error);
    }
  }

  public async findByRunId(runId: string): Promise<readonly Readonly<EvidenceCapsule>[]> {
    return await this.findByRunIdPage(runId, DEFAULT_EVIDENCE_PAGE);
  }

  public async findByRunIdAll(runId: string): Promise<readonly Readonly<EvidenceCapsule>[]> {
    try {
      const rows = this.statements.findByRunIdStatement.all(runId) as EvidenceCapsuleRow[];
      return rows.map((row) => parseEvidenceCapsuleRow(row));
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to list all evidence capsules for run ${runId}.`, error);
    }
  }

  public async findByRunIdPage(
    runId: string,
    page: EvidenceCapsuleListPageOptions
  ): Promise<readonly Readonly<EvidenceCapsule>[]> {
    const parsedPage = parseEvidenceCapsulePage(page);

    try {
      const rows = this.statements.findByRunIdPagedStatement.all(runId, parsedPage.limit, parsedPage.offset) as EvidenceCapsuleRow[];
      return rows.map((row) => parseEvidenceCapsuleRow(row));
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to list paged evidence capsules for run ${runId}.`, error);
    }
  }

  public async findByWorkspaceId(workspaceId: string): Promise<readonly Readonly<EvidenceCapsule>[]> {
    return await this.findByWorkspaceIdPage(workspaceId, DEFAULT_EVIDENCE_PAGE);
  }

  public async findByWorkspaceIdAll(workspaceId: string): Promise<readonly Readonly<EvidenceCapsule>[]> {
    try {
      const rows = this.statements.findByWorkspaceIdStatement.all(workspaceId) as EvidenceCapsuleRow[];
      return rows.map((row) => parseEvidenceCapsuleRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list all evidence capsules for workspace ${workspaceId}.`,
        error
      );
    }
  }

  public async findByWorkspaceIdPage(
    workspaceId: string,
    page: EvidenceCapsuleListPageOptions
  ): Promise<readonly Readonly<EvidenceCapsule>[]> {
    const parsedPage = parseEvidenceCapsulePage(page);

    try {
      const rows = this.statements.findByWorkspaceIdPagedStatement.all(
        workspaceId,
        parsedPage.limit,
        parsedPage.offset
      ) as EvidenceCapsuleRow[];
      return rows.map((row) => parseEvidenceCapsuleRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list paged evidence capsules for workspace ${workspaceId}.`,
        error
      );
    }
  }

  public async findByHealth(health: EvidenceHealthState): Promise<readonly Readonly<EvidenceCapsule>[]> {
    return await this.findByHealthPage(health, DEFAULT_EVIDENCE_PAGE);
  }

  public async findByHealthAll(health: EvidenceHealthState): Promise<readonly Readonly<EvidenceCapsule>[]> {
    const parsedHealth = parseEvidenceHealthState(health);

    try {
      const rows = this.statements.findByHealthStatement.all(parsedHealth) as EvidenceCapsuleRow[];
      return rows.map((row) => parseEvidenceCapsuleRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list all evidence capsules by health state ${parsedHealth}.`,
        error
      );
    }
  }

  public async findByHealthPage(
    health: EvidenceHealthState,
    page: EvidenceCapsuleListPageOptions
  ): Promise<readonly Readonly<EvidenceCapsule>[]> {
    const parsedHealth = parseEvidenceHealthState(health);
    const parsedPage = parseEvidenceCapsulePage(page);

    try {
      const rows = this.statements.findByHealthPagedStatement.all(
        parsedHealth,
        parsedPage.limit,
        parsedPage.offset
      ) as EvidenceCapsuleRow[];
      return rows.map((row) => parseEvidenceCapsuleRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list paged evidence capsules by health state ${parsedHealth}.`,
        error
      );
    }
  }

  public async updateHealth(
    objectId: string,
    health: EvidenceHealthState,
    updatedAt: string
  ): Promise<Readonly<EvidenceCapsule>> {
    const parsedHealth = parseEvidenceHealthState(health);
    const parsedUpdatedAt = parseUpdatedAt(updatedAt);

    try {
      const result = this.statements.updateHealthStatement.run(parsedHealth, parsedUpdatedAt, objectId);

      if (result.changes === 0) {
        throw new StorageError("NOT_FOUND", `Evidence capsule ${objectId} was not found.`);
      }

      const capsule = await this.findById(objectId);

      if (capsule === null) {
        throw new StorageError("NOT_FOUND", `Evidence capsule ${objectId} was not found after update.`);
      }

      return capsule;
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError("QUERY_FAILED", `Failed to update evidence health for ${objectId}.`, error);
    }
  }
}

function uniqueNonEmpty(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function sortSourceAnchors(rows: readonly EvidenceSourceAnchor[]): readonly EvidenceSourceAnchor[] {
  return [...rows].sort((left, right) =>
    left.evidence_object_id.localeCompare(right.evidence_object_id)
  );
}
