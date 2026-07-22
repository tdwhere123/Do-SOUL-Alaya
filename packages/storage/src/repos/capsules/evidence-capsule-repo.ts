import {
  type EvidenceCapsule,
  type EvidenceHealthState
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { RefreshableStatementHolder } from "../../sqlite/refreshable-statement-holder.js";
import { StorageError } from "../../shared/errors.js";
import {
  mergeFtsLanes,
  queryFtsLane,
  splitFtsLanes,
  tokenizeFtsQuery
} from "../shared/fts-lane-routing.js";
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

export interface EvidenceCapsuleKeywordHit {
  readonly object_id: string;
  readonly normalized_rank: number;
}

export interface EvidenceSourceAnchor {
  readonly evidence_object_id: string;
  readonly artifact_ref: string;
}

interface EvidenceSourceAnchorRow {
  readonly evidence_object_id: string;
  readonly artifact_ref: string | null;
}

export interface EvidenceCapsuleRepo {
  create(capsule: EvidenceCapsule): Promise<Readonly<EvidenceCapsule>>;
  deleteById(objectId: string): Promise<void>;
  findById(objectId: string): Promise<Readonly<EvidenceCapsule> | null>;
  findByIds(workspaceId: string, objectIds: readonly string[]): Promise<readonly Readonly<EvidenceCapsule>[]>;
  findSourceAnchorsByIds(
    workspaceId: string,
    evidenceObjectIds: readonly string[]
  ): Promise<readonly EvidenceSourceAnchor[]>;
  findByRunIdPage?(
    runId: string,
    page: EvidenceCapsuleListPageOptions
  ): Promise<readonly Readonly<EvidenceCapsule>[]>;
  findByRunId(runId: string): Promise<readonly Readonly<EvidenceCapsule>[]>;
  findByRunIdAll?(runId: string): Promise<readonly Readonly<EvidenceCapsule>[]>;
  findByWorkspaceIdPage?(
    workspaceId: string,
    page: EvidenceCapsuleListPageOptions
  ): Promise<readonly Readonly<EvidenceCapsule>[]>;
  findByWorkspaceId(workspaceId: string): Promise<readonly Readonly<EvidenceCapsule>[]>;
  findByWorkspaceIdAll?(workspaceId: string): Promise<readonly Readonly<EvidenceCapsule>[]>;
  findByHealthPage?(
    health: EvidenceHealthState,
    page: EvidenceCapsuleListPageOptions
  ): Promise<readonly Readonly<EvidenceCapsule>[]>;
  findByHealth(health: EvidenceHealthState): Promise<readonly Readonly<EvidenceCapsule>[]>;
  findByHealthAll?(health: EvidenceHealthState): Promise<readonly Readonly<EvidenceCapsule>[]>;
  updateHealth(
    objectId: string,
    health: EvidenceHealthState,
    updatedAt: string
  ): Promise<Readonly<EvidenceCapsule>>;
  // see also: memory_content_fts — parallel raw FTS surface
  searchByKeyword?(
    workspaceId: string,
    query: string,
    limit: number
  ): Promise<readonly EvidenceCapsuleKeywordHit[]>;
}

export interface EvidenceCapsuleListPageOptions {
  readonly limit: number;
  readonly offset: number;
}

// see also: packages/protocol/src/soul/fts-search-policy.ts — porter/trigram
// split and ordinal-rank merge shared with synthesis-capsule-repo.ts.
export class SqliteEvidenceCapsuleRepo implements EvidenceCapsuleRepo {
  private readonly statementHolder: RefreshableStatementHolder<EvidenceCapsuleStatements>;

  public constructor(private readonly db: StorageDatabase) {
    this.statementHolder = new RefreshableStatementHolder(db, prepareEvidenceCapsuleStatements);
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
    const trimmed = queryText.trim();
    if (trimmed.length === 0 || !Number.isInteger(limit) || limit <= 0) {
      return Object.freeze([]);
    }
    try {
      const tokens = tokenizeFtsQuery(trimmed);
      if (tokens.length === 0) {
        return Object.freeze([]);
      }
      // Script-routed dual-lane FTS: word tokens to the porter unicode61 lane,
      // CJK-bearing tokens to the trigram lane. The merged result preserves the
      // EvidenceCapsuleKeywordHit contract (normalized_rank, 1.0 = top).
      const { porterTokens, trigramTokens } = splitFtsLanes(tokens);
      const porterHits =
        porterTokens.length === 0
          ? []
          : queryFtsLane(this.statements.searchByKeywordStatement, workspaceId, porterTokens, limit);
      const trigramHits =
        trigramTokens.length === 0
          ? []
          : queryFtsLane(
              this.statements.searchByKeywordTrigramStatement,
              workspaceId,
              trigramTokens,
              limit
            );
      return mergeFtsLanes(porterHits, trigramHits, limit);
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to search evidence capsules for workspace ${workspaceId}.`,
        error
      );
    }
  }

  public async create(capsule: EvidenceCapsule): Promise<Readonly<EvidenceCapsule>> {
    const parsedCapsule = parseEvidenceCapsule(capsule);

    try {
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
