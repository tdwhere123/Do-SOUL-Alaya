import {
  type EvidenceCapsule,
  type EvidenceFactFrameFormationCapture,
  type OpenSemanticFactorFormationCapture,
  type EvidenceSearchProjection,
  type EvidenceHealthState
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { RefreshableStatementHolder } from "../../sqlite/refreshable-statement-holder.js";
import { StorageError } from "../../shared/errors.js";
import { toFieldSearchStorageError } from "../shared/field-search-errors.js";
import { parseOptionalRow, parseRows } from "../shared/parse-row.js";
import {
  searchEvidenceByKeyword,
  searchEvidenceByKeywordField
} from "./evidence-search/evidence-keyword-search.js";
import type {
  EvidenceCapsuleKeywordHit,
  EvidenceSearchMatch,
  RecallQualifiedEvidence,
  VerifiedAssertionLocatorResolver
} from "./evidence-recall-types.js";
import {
  loadEvidenceCapsulesByIds,
  loadEvidenceSourceAnchorsByIds,
  loadRecallQualifiedFactKeysByIds
} from "./evidence-capsule-bulk-read.js";
import {
  DEFAULT_EVIDENCE_PAGE,
  EvidenceCapsuleRowParser,
  parseEvidenceCapsule,
  parseEvidenceCapsulePage,
  parseEvidenceHealthState,
  parseUpdatedAt,
  wrapEvidenceCapsuleQueryError
} from "./evidence-capsule-mappers.js";
import {
  prepareEvidenceCapsuleStatements,
  type EvidenceCapsuleStatements
} from "./evidence-capsule-statements.js";
import { RecallQualifiedEvidenceReader } from "./recall-qualified-evidence-reader.js";
import { prepareFactFrameFormationInsert } from
  "./fact-frame-formation/capture-store.js";
import { prepareSemanticFactorFormationInsert } from
  "./semantic-factor-formation/capture-store.js";
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

// see also: packages/protocol/src/soul/fts-search-policy.ts — porter/trigram
// split and ordinal-rank merge shared with synthesis-capsule-repo.ts.
export class SqliteEvidenceCapsuleRepo implements EvidenceCapsuleRepo {
  private readonly statementHolder: RefreshableStatementHolder<EvidenceCapsuleStatements>;
  private readonly recallQualifiedReader: RecallQualifiedEvidenceReader;

  public constructor(
    private readonly db: StorageDatabase,
    resolveVerifiedAssertionLocator?: VerifiedAssertionLocatorResolver
  ) {
    this.statementHolder = new RefreshableStatementHolder(db, prepareEvidenceCapsuleStatements);
    this.recallQualifiedReader = new RecallQualifiedEvidenceReader(
      db,
      resolveVerifiedAssertionLocator
    );
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
    factFrameFormation?: Readonly<EvidenceFactFrameFormationCapture>,
    semanticFactorFormation?: Readonly<OpenSemanticFactorFormationCapture>
  ): Promise<Readonly<EvidenceCapsule>> {
    const parsedCapsule = parseEvidenceCapsule(capsule);
    const formationInsert = prepareFactFrameFormationInsert(
      parsedCapsule,
      searchProjections,
      factFrameFormation
    );
    const semanticFormationInsert = prepareSemanticFactorFormationInsert(
      parsedCapsule,
      semanticFactorFormation
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
        if (semanticFormationInsert !== null) {
          this.statements.createSemanticFactorFormationStatement.run(
            ...semanticFormationInsert
          );
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
      return parseOptionalRow(
        this.statements.findByIdStatement.get(objectId),
        EvidenceCapsuleRowParser,
        "evidence capsule row"
      );
    } catch (error) {
      throw wrapEvidenceCapsuleQueryError(`Failed to load evidence capsule ${objectId}.`, error);
    }
  }

  public async findByArtifactRef(
    workspaceId: string,
    artifactRef: string
  ): Promise<Readonly<EvidenceCapsule> | null> {
    try {
      return parseOptionalRow(
        this.statements.findByArtifactRefStatement.get(workspaceId, artifactRef),
        EvidenceCapsuleRowParser,
        "evidence capsule row"
      );
    } catch (error) {
      throw wrapEvidenceCapsuleQueryError(
        `Failed to load evidence capsule by artifact reference in workspace ${workspaceId}.`,
        error
      );
    }
  }

  public async findByIds(
    workspaceId: string,
    objectIds: readonly string[]
  ): Promise<readonly Readonly<EvidenceCapsule>[]> {
    return loadEvidenceCapsulesByIds(this.statements, workspaceId, objectIds);
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
    return loadRecallQualifiedFactKeysByIds(
      this.statements,
      this.recallQualifiedReader,
      workspaceId,
      evidenceObjectIds
    );
  }

  public async findSourceAnchorsByIds(
    workspaceId: string,
    evidenceObjectIds: readonly string[]
  ): Promise<readonly EvidenceSourceAnchor[]> {
    return loadEvidenceSourceAnchorsByIds(this.statements, workspaceId, evidenceObjectIds);
  }

  public async findByRunId(runId: string): Promise<readonly Readonly<EvidenceCapsule>[]> {
    return await this.findByRunIdPage(runId, DEFAULT_EVIDENCE_PAGE);
  }

  public async findByRunIdAll(runId: string): Promise<readonly Readonly<EvidenceCapsule>[]> {
    try {
      return parseRows(
        this.statements.findByRunIdStatement.all(runId),
        EvidenceCapsuleRowParser,
        "evidence capsule row"
      );
    } catch (error) {
      throw wrapEvidenceCapsuleQueryError(`Failed to list all evidence capsules for run ${runId}.`, error);
    }
  }

  public async findByRunIdPage(
    runId: string,
    page: EvidenceCapsuleListPageOptions
  ): Promise<readonly Readonly<EvidenceCapsule>[]> {
    const parsedPage = parseEvidenceCapsulePage(page);

    try {
      return parseRows(
        this.statements.findByRunIdPagedStatement.all(runId, parsedPage.limit, parsedPage.offset),
        EvidenceCapsuleRowParser,
        "evidence capsule row"
      );
    } catch (error) {
      throw wrapEvidenceCapsuleQueryError(`Failed to list paged evidence capsules for run ${runId}.`, error);
    }
  }

  public async findByWorkspaceId(workspaceId: string): Promise<readonly Readonly<EvidenceCapsule>[]> {
    return await this.findByWorkspaceIdPage(workspaceId, DEFAULT_EVIDENCE_PAGE);
  }

  public async findByWorkspaceIdAll(workspaceId: string): Promise<readonly Readonly<EvidenceCapsule>[]> {
    try {
      return parseRows(
        this.statements.findByWorkspaceIdStatement.all(workspaceId),
        EvidenceCapsuleRowParser,
        "evidence capsule row"
      );
    } catch (error) {
      throw wrapEvidenceCapsuleQueryError(
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
      return parseRows(
        this.statements.findByWorkspaceIdPagedStatement.all(
          workspaceId,
          parsedPage.limit,
          parsedPage.offset
        ),
        EvidenceCapsuleRowParser,
        "evidence capsule row"
      );
    } catch (error) {
      throw wrapEvidenceCapsuleQueryError(
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
      return parseRows(
        this.statements.findByHealthStatement.all(parsedHealth),
        EvidenceCapsuleRowParser,
        "evidence capsule row"
      );
    } catch (error) {
      throw wrapEvidenceCapsuleQueryError(
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
      return parseRows(
        this.statements.findByHealthPagedStatement.all(
          parsedHealth,
          parsedPage.limit,
          parsedPage.offset
        ),
        EvidenceCapsuleRowParser,
        "evidence capsule row"
      );
    } catch (error) {
      throw wrapEvidenceCapsuleQueryError(
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
