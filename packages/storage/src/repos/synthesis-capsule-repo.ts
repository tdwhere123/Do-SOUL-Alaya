import {
  SynthesisCapsuleSchema,
  SynthesisStatusSchema,
  type SynthesisCapsule,
  type SynthesisStatus
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../sqlite/db.js";
import { StorageError } from "../shared/errors.js";
import { deepFreeze } from "./shared/deep-freeze.js";
import {
  mergeFtsLanes,
  queryFtsLane,
  splitFtsLanes,
  tokenizeFtsQuery
} from "./shared/fts-lane-routing.js";
import { parseNonEmptyString, parseTimestamp } from "./shared/validators.js";

export interface SynthesisCapsuleKeywordHit {
  readonly object_id: string;
  readonly normalized_rank: number;
}

export interface SynthesisCapsuleRepo {
  create(capsule: SynthesisCapsule): Promise<Readonly<SynthesisCapsule>>;
  findById(objectId: string): Promise<Readonly<SynthesisCapsule> | null>;
  findByWorkspaceId(workspaceId: string): Promise<readonly Readonly<SynthesisCapsule>[]>;
  findByTopicKey(workspaceId: string, topicKey: string): Promise<readonly Readonly<SynthesisCapsule>[]>;
  clearEvidenceRef(objectId: string, evidenceRef: string, updatedAt: string): Promise<Readonly<SynthesisCapsule>>;
  clearSourceMemoryRef(
    objectId: string,
    memoryRef: string,
    updatedAt: string
  ): Promise<Readonly<SynthesisCapsule>>;
  updateStatus(
    objectId: string,
    status: SynthesisStatus,
    updatedAt: string
  ): Promise<Readonly<SynthesisCapsule>>;
  // see also: 079-synthesis-capsule-fts-dual.sql — porter + trigram FTS
  // over `summary`. Optional, mirroring evidence-capsule-repo.ts.
  searchByKeyword?(
    workspaceId: string,
    query: string,
    limit: number
  ): Promise<readonly SynthesisCapsuleKeywordHit[]>;
}

const SYNTHESIS_SELECT_COLUMNS = `
        object_id,
        object_kind,
        schema_version,
        lifecycle_state,
        created_at,
        updated_at,
        created_by,
        topic_key,
        synthesis_type,
        summary,
        evidence_refs,
        source_memory_refs,
        workspace_id,
        run_id,
        synthesis_status
`;

interface SynthesisCapsuleRow {
  readonly object_id: string;
  readonly object_kind: string;
  readonly schema_version: number;
  readonly lifecycle_state: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly created_by: string;
  readonly topic_key: string;
  readonly synthesis_type: string;
  readonly summary: string;
  readonly evidence_refs: string;
  readonly source_memory_refs: string;
  readonly workspace_id: string;
  readonly run_id: string;
  readonly synthesis_status: string;
}

// see also: ./shared/fts-lane-routing.ts — the porter/trigram dual-lane
// query split and ordinal-rank merge shared with evidence-capsule-repo.ts.
export class SqliteSynthesisCapsuleRepo implements SynthesisCapsuleRepo {
  private readonly createStatement;
  private readonly findByIdStatement;
  private readonly findByWorkspaceIdStatement;
  private readonly findByTopicKeyStatement;
  private readonly updateEvidenceRefsStatement;
  private readonly updateSourceMemoryRefsStatement;
  private readonly updateStatusStatement;
  // see also: 079-synthesis-capsule-fts-dual.sql — porter unicode61 word lane.
  private readonly searchByKeywordStatement;
  // see also: 079-synthesis-capsule-fts-dual.sql — trigram CJK/substring lane.
  private readonly searchByKeywordTrigramStatement;

  public constructor(db: StorageDatabase) {
    this.createStatement = db.connection.prepare(`
      INSERT INTO synthesis_capsules (
        object_id,
        object_kind,
        schema_version,
        lifecycle_state,
        created_at,
        updated_at,
        created_by,
        topic_key,
        synthesis_type,
        summary,
        evidence_refs,
        source_memory_refs,
        workspace_id,
        run_id,
        synthesis_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.findByIdStatement = db.connection.prepare(`
      SELECT${SYNTHESIS_SELECT_COLUMNS}
      FROM synthesis_capsules
      WHERE object_id = ?
      LIMIT 1
    `);

    this.findByWorkspaceIdStatement = db.connection.prepare(`
      SELECT${SYNTHESIS_SELECT_COLUMNS}
      FROM synthesis_capsules
      WHERE workspace_id = ?
      ORDER BY created_at ASC, object_id ASC
    `);

    this.findByTopicKeyStatement = db.connection.prepare(`
      SELECT${SYNTHESIS_SELECT_COLUMNS}
      FROM synthesis_capsules
      WHERE workspace_id = ?
        AND topic_key = ?
      ORDER BY created_at ASC, object_id ASC
    `);

    this.updateEvidenceRefsStatement = db.connection.prepare(`
      UPDATE synthesis_capsules
      SET evidence_refs = ?, updated_at = ?
      WHERE object_id = ?
    `);

    this.updateSourceMemoryRefsStatement = db.connection.prepare(`
      UPDATE synthesis_capsules
      SET source_memory_refs = ?, updated_at = ?
      WHERE object_id = ?
    `);

    this.updateStatusStatement = db.connection.prepare(`
      UPDATE synthesis_capsules
      SET synthesis_status = ?, updated_at = ?
      WHERE object_id = ?
    `);

    this.searchByKeywordStatement = db.connection.prepare(`
      SELECT
        synthesis_capsule_fts.object_id,
        bm25(synthesis_capsule_fts) AS raw_rank
      FROM synthesis_capsule_fts
      JOIN synthesis_capsules ON synthesis_capsules.object_id = synthesis_capsule_fts.object_id
      WHERE
        synthesis_capsule_fts.workspace_id = ?
        AND synthesis_capsule_fts MATCH ?
        AND COALESCE(synthesis_capsules.lifecycle_state, '') != 'retired'
      ORDER BY raw_rank ASC, synthesis_capsule_fts.object_id ASC
      LIMIT ?
    `);
    this.searchByKeywordTrigramStatement = db.connection.prepare(`
      SELECT
        synthesis_capsule_fts_trigram.object_id,
        bm25(synthesis_capsule_fts_trigram) AS raw_rank
      FROM synthesis_capsule_fts_trigram
      JOIN synthesis_capsules
        ON synthesis_capsules.object_id = synthesis_capsule_fts_trigram.object_id
      WHERE
        synthesis_capsule_fts_trigram.workspace_id = ?
        AND synthesis_capsule_fts_trigram MATCH ?
        AND COALESCE(synthesis_capsules.lifecycle_state, '') != 'retired'
      ORDER BY raw_rank ASC, synthesis_capsule_fts_trigram.object_id ASC
      LIMIT ?
    `);
  }

  public async searchByKeyword(
    workspaceId: string,
    queryText: string,
    limit: number
  ): Promise<readonly SynthesisCapsuleKeywordHit[]> {
    const trimmed = queryText.trim();
    if (trimmed.length === 0 || !Number.isInteger(limit) || limit <= 0) {
      return Object.freeze([]);
    }
    try {
      const tokens = tokenizeFtsQuery(trimmed);
      if (tokens.length === 0) {
        return Object.freeze([]);
      }
      // Script-routed dual-lane FTS over synthesis_capsules.summary: word
      // tokens to the porter unicode61 lane, CJK-bearing tokens to the trigram
      // lane. The merged result preserves the SynthesisCapsuleKeywordHit
      // contract (normalized_rank, 1.0 = top).
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
        `Failed to search synthesis capsules for workspace ${workspaceId}.`,
        error
      );
    }
  }

  public async create(capsule: SynthesisCapsule): Promise<Readonly<SynthesisCapsule>> {
    const parsedCapsule = parseSynthesisCapsule(capsule);

    try {
      this.createStatement.run(
        parsedCapsule.object_id,
        parsedCapsule.object_kind,
        parsedCapsule.schema_version,
        parsedCapsule.lifecycle_state,
        parsedCapsule.created_at,
        parsedCapsule.updated_at,
        parsedCapsule.created_by,
        parsedCapsule.topic_key,
        parsedCapsule.synthesis_type,
        parsedCapsule.summary,
        JSON.stringify(parsedCapsule.evidence_refs),
        JSON.stringify(parsedCapsule.source_memory_refs),
        parsedCapsule.workspace_id,
        parsedCapsule.run_id,
        parsedCapsule.synthesis_status
      );
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to create synthesis capsule ${parsedCapsule.object_id}.`,
        error
      );
    }

    return parsedCapsule;
  }

  public async findById(objectId: string): Promise<Readonly<SynthesisCapsule> | null> {
    try {
      const row = this.findByIdStatement.get(objectId) as SynthesisCapsuleRow | undefined;
      return row === undefined ? null : parseSynthesisCapsuleRow(row);
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to load synthesis capsule ${objectId}.`, error);
    }
  }

  public async findByWorkspaceId(workspaceId: string): Promise<readonly Readonly<SynthesisCapsule>[]> {
    try {
      const rows = this.findByWorkspaceIdStatement.all(workspaceId) as SynthesisCapsuleRow[];
      return rows.map((row) => parseSynthesisCapsuleRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list synthesis capsules for workspace ${workspaceId}.`,
        error
      );
    }
  }

  public async findByTopicKey(workspaceId: string, topicKey: string): Promise<readonly Readonly<SynthesisCapsule>[]> {
    try {
      const rows = this.findByTopicKeyStatement.all(workspaceId, topicKey) as SynthesisCapsuleRow[];
      return rows.map((row) => parseSynthesisCapsuleRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list synthesis capsules for topic ${topicKey}.`,
        error
      );
    }
  }

  public async updateStatus(
    objectId: string,
    status: SynthesisStatus,
    updatedAt: string
  ): Promise<Readonly<SynthesisCapsule>> {
    const parsedStatus = parseSynthesisStatus(status);
    const parsedUpdatedAt = parseUpdatedAt(updatedAt);

    try {
      const result = this.updateStatusStatement.run(parsedStatus, parsedUpdatedAt, objectId);

      if (result.changes === 0) {
        throw new StorageError("NOT_FOUND", `Synthesis capsule ${objectId} was not found.`);
      }

      const updated = await this.findById(objectId);

      if (updated === null) {
        throw new StorageError("NOT_FOUND", `Synthesis capsule ${objectId} was not found after update.`);
      }

      return updated;
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError("QUERY_FAILED", `Failed to update status for synthesis ${objectId}.`, error);
    }
  }

  public async clearEvidenceRef(
    objectId: string,
    evidenceRef: string,
    updatedAt: string
  ): Promise<Readonly<SynthesisCapsule>> {
    const synthesis = await this.requireSynthesisCapsule(objectId);
    const parsedEvidenceRef = parseNonEmptyString(evidenceRef, "evidence ref");
    const parsedUpdatedAt = parseUpdatedAt(updatedAt);
    const nextEvidenceRefs = synthesis.evidence_refs.filter((ref) => ref !== parsedEvidenceRef);

    return await this.updateRefs(
      objectId,
      nextEvidenceRefs,
      parsedUpdatedAt,
      this.updateEvidenceRefsStatement,
      "synthesis evidence refs"
    );
  }

  public async clearSourceMemoryRef(
    objectId: string,
    memoryRef: string,
    updatedAt: string
  ): Promise<Readonly<SynthesisCapsule>> {
    const synthesis = await this.requireSynthesisCapsule(objectId);
    const parsedMemoryRef = parseNonEmptyString(memoryRef, "memory ref");
    const parsedUpdatedAt = parseUpdatedAt(updatedAt);
    const nextSourceMemoryRefs = synthesis.source_memory_refs.filter((ref) => ref !== parsedMemoryRef);

    return await this.updateRefs(
      objectId,
      nextSourceMemoryRefs,
      parsedUpdatedAt,
      this.updateSourceMemoryRefsStatement,
      "synthesis source memory refs"
    );
  }

  private async requireSynthesisCapsule(objectId: string): Promise<Readonly<SynthesisCapsule>> {
    const synthesis = await this.findById(objectId);

    if (synthesis === null) {
      throw new StorageError("NOT_FOUND", `Synthesis capsule ${objectId} was not found.`);
    }

    return synthesis;
  }

  private async updateRefs(
    objectId: string,
    refs: readonly string[],
    updatedAt: string,
    statement: { run: (...args: unknown[]) => { changes: number } },
    description: string
  ): Promise<Readonly<SynthesisCapsule>> {
    try {
      const result = statement.run(JSON.stringify(refs), updatedAt, objectId);

      if (result.changes === 0) {
        throw new StorageError("NOT_FOUND", `Synthesis capsule ${objectId} was not found.`);
      }

      const updated = await this.findById(objectId);

      if (updated === null) {
        throw new StorageError("NOT_FOUND", `Synthesis capsule ${objectId} was not found after update.`);
      }

      return updated;
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError("QUERY_FAILED", `Failed to update ${description} for synthesis ${objectId}.`, error);
    }
  }
}

function parseSynthesisCapsule(value: SynthesisCapsule): Readonly<SynthesisCapsule> {
  try {
    return deepFreeze(SynthesisCapsuleSchema.parse(value));
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate synthesis capsule.", error);
  }
}

function parseSynthesisCapsuleRow(row: SynthesisCapsuleRow): Readonly<SynthesisCapsule> {
  try {
    return deepFreeze(
      SynthesisCapsuleSchema.parse({
        object_id: row.object_id,
        object_kind: row.object_kind,
        schema_version: row.schema_version,
        lifecycle_state: row.lifecycle_state,
        created_at: row.created_at,
        updated_at: row.updated_at,
        created_by: row.created_by,
        topic_key: row.topic_key,
        synthesis_type: row.synthesis_type,
        summary: row.summary,
        evidence_refs: JSON.parse(row.evidence_refs),
        source_memory_refs: JSON.parse(row.source_memory_refs),
        workspace_id: row.workspace_id,
        run_id: row.run_id,
        synthesis_status: row.synthesis_status
      })
    );
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate synthesis capsule row.", error);
  }
}

function parseSynthesisStatus(value: SynthesisStatus): SynthesisStatus {
  try {
    return SynthesisStatusSchema.parse(value);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate synthesis status.", error);
  }
}

const parseUpdatedAt = parseTimestamp;
