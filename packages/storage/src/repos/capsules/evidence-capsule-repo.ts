import {
  type EvidenceCapsule,
  type EvidenceHealthState
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";
import {
  mergeFtsLanes,
  queryFtsLane,
  splitFtsLanes,
  tokenizeFtsQuery
} from "../shared/fts-lane-routing.js";
import {
  DEFAULT_EVIDENCE_PAGE,
  EVIDENCE_CAPSULE_SELECT_COLUMNS,
  parseEvidenceCapsule,
  parseEvidenceCapsulePage,
  parseEvidenceCapsuleRow,
  parseEvidenceHealthState,
  parseUpdatedAt,
  type EvidenceCapsuleRow
} from "./evidence-capsule-mappers.js";
import { prepareEvidenceCapsuleStatements, type SqliteStatement } from "./evidence-capsule-statements.js";

export interface EvidenceCapsuleKeywordHit {
  readonly object_id: string;
  readonly normalized_rank: number;
}

export interface EvidenceCapsuleRepo {
  create(capsule: EvidenceCapsule): Promise<Readonly<EvidenceCapsule>>;
  findById(objectId: string): Promise<Readonly<EvidenceCapsule> | null>;
  findByIds(objectIds: readonly string[]): Promise<readonly Readonly<EvidenceCapsule>[]>;
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
  private readonly createStatement: SqliteStatement;
  private readonly findByIdStatement: SqliteStatement;
  private readonly findByRunIdStatement: SqliteStatement;
  private readonly findByRunIdPagedStatement: SqliteStatement;
  private readonly findByWorkspaceIdStatement: SqliteStatement;
  private readonly findByWorkspaceIdPagedStatement: SqliteStatement;
  private readonly findByHealthStatement: SqliteStatement;
  private readonly findByHealthPagedStatement: SqliteStatement;
  private readonly updateHealthStatement: SqliteStatement;
  // see also: 078-evidence-capsule-fts-dual.sql — porter unicode61 word lane.
  private readonly searchByKeywordStatement: SqliteStatement;
  // see also: 078-evidence-capsule-fts-dual.sql — trigram CJK/substring lane.
  private readonly searchByKeywordTrigramStatement: SqliteStatement;

  public constructor(private readonly db: StorageDatabase) {
    const statements = prepareEvidenceCapsuleStatements(db);
    this.createStatement = statements.createStatement;
    this.findByIdStatement = statements.findByIdStatement;
    this.findByRunIdStatement = statements.findByRunIdStatement;
    this.findByRunIdPagedStatement = statements.findByRunIdPagedStatement;
    this.findByWorkspaceIdStatement = statements.findByWorkspaceIdStatement;
    this.findByWorkspaceIdPagedStatement = statements.findByWorkspaceIdPagedStatement;
    this.findByHealthStatement = statements.findByHealthStatement;
    this.findByHealthPagedStatement = statements.findByHealthPagedStatement;
    this.updateHealthStatement = statements.updateHealthStatement;
    this.searchByKeywordStatement = statements.searchByKeywordStatement;
    this.searchByKeywordTrigramStatement = statements.searchByKeywordTrigramStatement;
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
          : queryFtsLane(this.searchByKeywordStatement, workspaceId, porterTokens, limit);
      const trigramHits =
        trigramTokens.length === 0
          ? []
          : queryFtsLane(
              this.searchByKeywordTrigramStatement,
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
      this.createStatement.run(
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

  public async findById(objectId: string): Promise<Readonly<EvidenceCapsule> | null> {
    try {
      const row = this.findByIdStatement.get(objectId) as EvidenceCapsuleRow | undefined;
      return row === undefined ? null : parseEvidenceCapsuleRow(row);
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to load evidence capsule ${objectId}.`, error);
    }
  }

  public async findByIds(objectIds: readonly string[]): Promise<readonly Readonly<EvidenceCapsule>[]> {
    const uniqueIds = [...new Set(objectIds.map((objectId) => objectId.trim()).filter((objectId) => objectId.length > 0))];
    if (uniqueIds.length === 0) {
      return [];
    }

    try {
      const rows: EvidenceCapsuleRow[] = [];
      for (let offset = 0; offset < uniqueIds.length; offset += 500) {
        const chunk = uniqueIds.slice(offset, offset + 500);
        const placeholders = chunk.map(() => "?").join(", ");
        const statement = this.db.connection.prepare(`
          SELECT${EVIDENCE_CAPSULE_SELECT_COLUMNS}
          FROM evidence_capsules
          WHERE object_id IN (${placeholders})
          ORDER BY created_at ASC, object_id ASC
        `);
        rows.push(...statement.all(...chunk) as EvidenceCapsuleRow[]);
      }
      return rows.map((row) => parseEvidenceCapsuleRow(row));
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to load evidence capsules by ids.", error);
    }
  }

  public async findByRunId(runId: string): Promise<readonly Readonly<EvidenceCapsule>[]> {
    return await this.findByRunIdPage(runId, DEFAULT_EVIDENCE_PAGE);
  }

  public async findByRunIdAll(runId: string): Promise<readonly Readonly<EvidenceCapsule>[]> {
    try {
      const rows = this.findByRunIdStatement.all(runId) as EvidenceCapsuleRow[];
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
      const rows = this.findByRunIdPagedStatement.all(runId, parsedPage.limit, parsedPage.offset) as EvidenceCapsuleRow[];
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
      const rows = this.findByWorkspaceIdStatement.all(workspaceId) as EvidenceCapsuleRow[];
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
      const rows = this.findByWorkspaceIdPagedStatement.all(
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
      const rows = this.findByHealthStatement.all(parsedHealth) as EvidenceCapsuleRow[];
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
      const rows = this.findByHealthPagedStatement.all(
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
      const result = this.updateHealthStatement.run(parsedHealth, parsedUpdatedAt, objectId);

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
