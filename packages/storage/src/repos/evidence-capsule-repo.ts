import type BetterSqlite3 from "better-sqlite3";
import {
  EvidenceCapsuleSchema,
  EvidenceHealthStateSchema,
  type EvidenceCapsule,
  type EvidenceHealthState
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../db.js";
import { StorageError } from "../errors.js";
import { buildGroupedOrdinalScores } from "./memory-entry-keyword-search.js";
import { deepFreeze } from "./shared/deep-freeze.js";
import { parseTimestamp } from "./shared/validators.js";

export interface EvidenceCapsuleKeywordHit {
  readonly object_id: string;
  readonly normalized_rank: number;
}

export interface EvidenceCapsuleRepo {
  create(capsule: EvidenceCapsule): Promise<Readonly<EvidenceCapsule>>;
  findById(objectId: string): Promise<Readonly<EvidenceCapsule> | null>;
  findByIds(objectIds: readonly string[]): Promise<readonly Readonly<EvidenceCapsule>[]>;
  findByRunId(runId: string): Promise<readonly Readonly<EvidenceCapsule>[]>;
  findByWorkspaceId(workspaceId: string): Promise<readonly Readonly<EvidenceCapsule>[]>;
  findByHealth(health: EvidenceHealthState): Promise<readonly Readonly<EvidenceCapsule>[]>;
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

interface EvidenceCapsuleRow {
  readonly object_id: string;
  readonly object_kind: string;
  readonly schema_version: number;
  readonly lifecycle_state: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly created_by: string;
  readonly evidence_kind: string;
  readonly semantic_anchor: string;
  readonly event_anchor: string | null;
  readonly physical_anchor: string | null;
  readonly evidence_health_state: string;
  readonly gist: string;
  readonly excerpt: string | null;
  readonly source_hash: string | null;
  readonly run_id: string;
  readonly workspace_id: string;
  readonly surface_id: string | null;
}

// Trigram FTS5 tables only index runs of >= 3 codepoints; shorter terms can
// never match and must not be sent to the trigram lane.
const TRIGRAM_MIN_CODEPOINTS = 3;
// A token routed to the trigram lane if it carries any CJK-family character;
// unicode61 collapses such a run into one token and is effectively blind to it.
const CJK_SCRIPT_PATTERN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

interface EvidenceFtsLaneSplit {
  readonly porterTokens: readonly string[];
  readonly trigramTokens: readonly string[];
}

/**
 * Route evidence FTS query tokens by character script. CJK-bearing tokens go
 * to the trigram lane (substring-capable); plain word tokens go to the porter
 * unicode61 lane (English BM25 + stemming). A mixed-script query fans out to
 * both lanes. Kept evidence-local so the shared `tokenizeFtsQuery` helper
 * (memory-entry side) stays untouched.
 */
function splitEvidenceFtsLanes(tokens: readonly string[]): EvidenceFtsLaneSplit {
  const porterTokens: string[] = [];
  const trigramTokens: string[] = [];
  for (const token of tokens) {
    if (CJK_SCRIPT_PATTERN.test(token)) {
      if (Array.from(token).length >= TRIGRAM_MIN_CODEPOINTS) {
        trigramTokens.push(token);
      }
    } else {
      porterTokens.push(token);
    }
  }
  return Object.freeze({
    porterTokens: Object.freeze(porterTokens),
    trigramTokens: Object.freeze(trigramTokens)
  });
}

function buildEvidenceFtsMatchExpression(tokens: readonly string[]): string {
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(" OR ");
}

export class SqliteEvidenceCapsuleRepo implements EvidenceCapsuleRepo {
  private readonly createStatement;
  private readonly findByIdStatement;
  private readonly findByRunIdStatement;
  private readonly findByWorkspaceIdStatement;
  private readonly findByHealthStatement;
  private readonly updateHealthStatement;
  // see also: 078-evidence-capsule-fts-dual.sql — porter unicode61 word lane.
  private readonly searchByKeywordStatement;
  // see also: 078-evidence-capsule-fts-dual.sql — trigram CJK/substring lane.
  private readonly searchByKeywordTrigramStatement;

  public constructor(private readonly db: StorageDatabase) {
    this.createStatement = db.connection.prepare(`
      INSERT INTO evidence_capsules (
        object_id,
        object_kind,
        schema_version,
        lifecycle_state,
        created_at,
        updated_at,
        created_by,
        evidence_kind,
        semantic_anchor,
        event_anchor,
        physical_anchor,
        evidence_health_state,
        gist,
        excerpt,
        source_hash,
        run_id,
        workspace_id,
        surface_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.findByIdStatement = db.connection.prepare(`
      SELECT
        object_id,
        object_kind,
        schema_version,
        lifecycle_state,
        created_at,
        updated_at,
        created_by,
        evidence_kind,
        semantic_anchor,
        event_anchor,
        physical_anchor,
        evidence_health_state,
        gist,
        excerpt,
        source_hash,
        run_id,
        workspace_id,
        surface_id
      FROM evidence_capsules
      WHERE object_id = ?
      LIMIT 1
    `);
    this.findByRunIdStatement = db.connection.prepare(`
      SELECT
        object_id,
        object_kind,
        schema_version,
        lifecycle_state,
        created_at,
        updated_at,
        created_by,
        evidence_kind,
        semantic_anchor,
        event_anchor,
        physical_anchor,
        evidence_health_state,
        gist,
        excerpt,
        source_hash,
        run_id,
        workspace_id,
        surface_id
      FROM evidence_capsules
      WHERE run_id = ?
      ORDER BY created_at ASC, object_id ASC
    `);
    this.findByWorkspaceIdStatement = db.connection.prepare(`
      SELECT
        object_id,
        object_kind,
        schema_version,
        lifecycle_state,
        created_at,
        updated_at,
        created_by,
        evidence_kind,
        semantic_anchor,
        event_anchor,
        physical_anchor,
        evidence_health_state,
        gist,
        excerpt,
        source_hash,
        run_id,
        workspace_id,
        surface_id
      FROM evidence_capsules
      WHERE workspace_id = ?
      ORDER BY created_at ASC, object_id ASC
    `);
    this.findByHealthStatement = db.connection.prepare(`
      SELECT
        object_id,
        object_kind,
        schema_version,
        lifecycle_state,
        created_at,
        updated_at,
        created_by,
        evidence_kind,
        semantic_anchor,
        event_anchor,
        physical_anchor,
        evidence_health_state,
        gist,
        excerpt,
        source_hash,
        run_id,
        workspace_id,
        surface_id
      FROM evidence_capsules
      WHERE evidence_health_state = ?
      ORDER BY created_at ASC, object_id ASC
    `);
    this.updateHealthStatement = db.connection.prepare(`
      UPDATE evidence_capsules
      SET evidence_health_state = ?, updated_at = ?
      WHERE object_id = ?
    `);
    this.searchByKeywordStatement = db.connection.prepare(`
      SELECT
        evidence_capsule_fts.object_id,
        bm25(evidence_capsule_fts) AS raw_rank
      FROM evidence_capsule_fts
      JOIN evidence_capsules ON evidence_capsules.object_id = evidence_capsule_fts.object_id
      WHERE
        evidence_capsule_fts.workspace_id = ?
        AND evidence_capsule_fts MATCH ?
        AND COALESCE(evidence_capsules.lifecycle_state, '') != 'retired'
      ORDER BY raw_rank ASC, evidence_capsule_fts.object_id ASC
      LIMIT ?
    `);
    this.searchByKeywordTrigramStatement = db.connection.prepare(`
      SELECT
        evidence_capsule_fts_trigram.object_id,
        bm25(evidence_capsule_fts_trigram) AS raw_rank
      FROM evidence_capsule_fts_trigram
      JOIN evidence_capsules
        ON evidence_capsules.object_id = evidence_capsule_fts_trigram.object_id
      WHERE
        evidence_capsule_fts_trigram.workspace_id = ?
        AND evidence_capsule_fts_trigram MATCH ?
        AND COALESCE(evidence_capsules.lifecycle_state, '') != 'retired'
      ORDER BY raw_rank ASC, evidence_capsule_fts_trigram.object_id ASC
      LIMIT ?
    `);
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
      const tokens = trimmed
        .normalize("NFKC")
        .split(/[^\p{L}\p{N}_]+/u)
        .filter((token) => token.length >= 2)
        .slice(0, 16);
      if (tokens.length === 0) {
        return Object.freeze([]);
      }
      // Script-routed dual-lane FTS: word tokens to the porter unicode61 lane,
      // CJK-bearing tokens to the trigram lane. The merged result preserves the
      // EvidenceCapsuleKeywordHit contract (normalized_rank, 1.0 = top).
      const { porterTokens, trigramTokens } = splitEvidenceFtsLanes(tokens);
      const porterHits =
        porterTokens.length === 0
          ? []
          : this.queryEvidenceFtsLane(
              this.searchByKeywordStatement,
              workspaceId,
              porterTokens,
              limit
            );
      const trigramHits =
        trigramTokens.length === 0
          ? []
          : this.queryEvidenceFtsLane(
              this.searchByKeywordTrigramStatement,
              workspaceId,
              trigramTokens,
              limit
            );

      // Cross-lane fusion mirrors the memory-entry side: each lane is scored by
      // ordinal rank (position-only, BM25-magnitude-independent) so the porter
      // and trigram lanes share one comparable scale. A lane-priority tiebreak
      // (porter 0 outranks trigram 1) makes an exact score tie deterministic
      // toward the higher-trust word lane rather than an arbitrary id sort.
      const merged = new Map<
        string,
        Readonly<{ normalizedRank: number; lanePriority: number; laneOrder: number }>
      >();
      const considerLaneHit = (
        hit: EvidenceCapsuleKeywordHit,
        lanePriority: number,
        laneOrder: number
      ): void => {
        const existing = merged.get(hit.object_id);
        if (
          existing !== undefined &&
          (existing.normalizedRank > hit.normalized_rank ||
            (existing.normalizedRank === hit.normalized_rank &&
              existing.lanePriority <= lanePriority))
        ) {
          return;
        }
        merged.set(
          hit.object_id,
          Object.freeze({ normalizedRank: hit.normalized_rank, lanePriority, laneOrder })
        );
      };
      porterHits.forEach((hit, index) => considerLaneHit(hit, 0, index));
      trigramHits.forEach((hit, index) => considerLaneHit(hit, 1, index));
      if (merged.size === 0) {
        return Object.freeze([]);
      }
      return Object.freeze(
        [...merged.entries()]
          .sort((left, right) => {
            const rankDelta = right[1].normalizedRank - left[1].normalizedRank;
            if (rankDelta !== 0) {
              return rankDelta;
            }
            const priorityDelta = left[1].lanePriority - right[1].lanePriority;
            if (priorityDelta !== 0) {
              return priorityDelta;
            }
            const orderDelta = left[1].laneOrder - right[1].laneOrder;
            if (orderDelta !== 0) {
              return orderDelta;
            }
            return left[0].localeCompare(right[0]);
          })
          .slice(0, limit)
          .map(([objectId, entry]) =>
            Object.freeze({ object_id: objectId, normalized_rank: entry.normalizedRank })
          )
      );
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to search evidence capsules for workspace ${workspaceId}.`,
        error
      );
    }
  }

  private queryEvidenceFtsLane(
    statement: BetterSqlite3.Statement,
    workspaceId: string,
    laneTokens: readonly string[],
    limit: number
  ): readonly EvidenceCapsuleKeywordHit[] {
    const matchExpression = buildEvidenceFtsMatchExpression(laneTokens);
    const rows = statement.all(workspaceId, matchExpression, limit) as ReadonlyArray<{
      readonly object_id: string;
      readonly raw_rank: number;
    }>;
    if (rows.length === 0) {
      return [];
    }
    // Rows arrive ordered by raw bm25 (best first). Score by ordinal rank, not
    // raw bm25 magnitude: an affine min-max would pin a lane's own best hit to
    // 1.0 regardless of absolute match quality, so a weak hit in a narrow-span
    // lane could outrank a strong hit in a wide-span lane after merge. Ordinal
    // scores share one comparable scale across the porter and trigram lanes.
    const scores = buildGroupedOrdinalScores(rows, (row) => row.raw_rank);
    return rows.map((row, index) =>
      Object.freeze({
        object_id: row.object_id,
        normalized_rank: scores[index] ?? 0
      })
    );
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
          SELECT
            object_id,
            object_kind,
            schema_version,
            lifecycle_state,
            created_at,
            updated_at,
            created_by,
            evidence_kind,
            semantic_anchor,
            event_anchor,
            physical_anchor,
            evidence_health_state,
            gist,
            excerpt,
            source_hash,
            run_id,
            workspace_id,
            surface_id
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
    try {
      const rows = this.findByRunIdStatement.all(runId) as EvidenceCapsuleRow[];
      return rows.map((row) => parseEvidenceCapsuleRow(row));
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to list evidence capsules for run ${runId}.`, error);
    }
  }

  public async findByWorkspaceId(workspaceId: string): Promise<readonly Readonly<EvidenceCapsule>[]> {
    try {
      const rows = this.findByWorkspaceIdStatement.all(workspaceId) as EvidenceCapsuleRow[];
      return rows.map((row) => parseEvidenceCapsuleRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list evidence capsules for workspace ${workspaceId}.`,
        error
      );
    }
  }

  public async findByHealth(health: EvidenceHealthState): Promise<readonly Readonly<EvidenceCapsule>[]> {
    const parsedHealth = parseEvidenceHealthState(health);

    try {
      const rows = this.findByHealthStatement.all(parsedHealth) as EvidenceCapsuleRow[];
      return rows.map((row) => parseEvidenceCapsuleRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list evidence capsules by health state ${parsedHealth}.`,
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

function parseEvidenceCapsule(value: EvidenceCapsule): Readonly<EvidenceCapsule> {
  try {
    return deepFreeze(EvidenceCapsuleSchema.parse(value));
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate evidence capsule.", error);
  }
}

function parseEvidenceCapsuleRow(row: EvidenceCapsuleRow): Readonly<EvidenceCapsule> {
  try {
    return deepFreeze(
      EvidenceCapsuleSchema.parse({
        object_id: row.object_id,
        object_kind: row.object_kind,
        schema_version: row.schema_version,
        lifecycle_state: row.lifecycle_state,
        created_at: row.created_at,
        updated_at: row.updated_at,
        created_by: row.created_by,
        evidence_kind: row.evidence_kind,
        semantic_anchor: JSON.parse(row.semantic_anchor),
        event_anchor: row.event_anchor === null ? null : JSON.parse(row.event_anchor),
        physical_anchor: row.physical_anchor === null ? null : JSON.parse(row.physical_anchor),
        evidence_health_state: row.evidence_health_state,
        gist: row.gist,
        excerpt: row.excerpt,
        source_hash: row.source_hash,
        run_id: row.run_id,
        workspace_id: row.workspace_id,
        surface_id: row.surface_id
      })
    );
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate evidence capsule row.", error);
  }
}

function parseEvidenceHealthState(health: EvidenceHealthState): EvidenceHealthState {
  try {
    return EvidenceHealthStateSchema.parse(health);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate evidence health state.", error);
  }
}

const parseUpdatedAt = parseTimestamp;
