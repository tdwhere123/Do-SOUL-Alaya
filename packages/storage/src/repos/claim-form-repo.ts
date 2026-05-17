import {
  ClaimFormSchema,
  ClaimLifecycleStateSchema,
  type ClaimForm,
  type ClaimLifecycleState
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../db.js";
import { StorageError } from "../errors.js";
import { deepFreeze } from "./shared/deep-freeze.js";
import { parseNonEmptyString, parseTimestamp } from "./shared/validators.js";

export interface ClaimFormRepo {
  create(claim: ClaimForm): Readonly<ClaimForm>;
  findById(objectId: string): Promise<Readonly<ClaimForm> | null>;
  findByIds(objectIds: readonly string[]): Promise<readonly Readonly<ClaimForm>[]>;
  findByWorkspaceId(workspaceId: string): Promise<readonly Readonly<ClaimForm>[]>;
  findByStatus(workspaceId: string, status: ClaimLifecycleState): Promise<readonly Readonly<ClaimForm>[]>;
  findByCanonicalKey(workspaceId: string, canonicalKey: string): Promise<readonly Readonly<ClaimForm>[]>;
  clearEvidenceRef(objectId: string, evidenceRef: string, updatedAt: string): Promise<Readonly<ClaimForm>>;
  clearSourceObjectRef(
    objectId: string,
    sourceObjectRef: string,
    updatedAt: string
  ): Promise<Readonly<ClaimForm>>;
  updateStatus(
    objectId: string,
    status: ClaimLifecycleState,
    updatedAt: string,
    expectedFromStatus: ClaimLifecycleState
  ): Promise<Readonly<ClaimForm>>;
}

const CLAIM_FORM_SELECT_COLUMNS = `
        object_id,
        object_kind,
        schema_version,
        lifecycle_state,
        created_at,
        updated_at,
        created_by,
        governance_subject,
        claim_kind,
        scope_class,
        enforcement_level,
        origin_tier,
        precedence_basis,
        proposition_digest,
        evidence_refs,
        source_object_refs,
        workspace_id,
        claim_status
`;

interface ClaimFormRow {
  readonly object_id: string;
  readonly object_kind: string;
  readonly schema_version: number;
  readonly lifecycle_state: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly created_by: string;
  readonly governance_subject: string;
  readonly claim_kind: string;
  readonly scope_class: string;
  readonly enforcement_level: string;
  readonly origin_tier: string;
  readonly precedence_basis: string;
  readonly proposition_digest: string;
  readonly evidence_refs: string;
  readonly source_object_refs: string;
  readonly workspace_id: string;
  readonly claim_status: string;
}

export class SqliteClaimFormRepo implements ClaimFormRepo {
  private readonly createStatement;
  private readonly findByIdStatement;
  private readonly findByWorkspaceIdStatement;
  private readonly findByStatusStatement;
  private readonly findByCanonicalKeyStatement;
  private readonly updateEvidenceRefsStatement;
  private readonly updateSourceObjectRefsStatement;
  private readonly updateStatusStatement;

  public constructor(private readonly db: StorageDatabase) {
    this.createStatement = db.connection.prepare(`
      INSERT INTO claim_forms (
        object_id,
        object_kind,
        schema_version,
        lifecycle_state,
        created_at,
        updated_at,
        created_by,
        governance_subject,
        claim_kind,
        scope_class,
        enforcement_level,
        origin_tier,
        precedence_basis,
        proposition_digest,
        evidence_refs,
        source_object_refs,
        workspace_id,
        claim_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.findByIdStatement = db.connection.prepare(`
      SELECT${CLAIM_FORM_SELECT_COLUMNS}
      FROM claim_forms
      WHERE object_id = ?
      LIMIT 1
    `);

    this.findByWorkspaceIdStatement = db.connection.prepare(`
      SELECT${CLAIM_FORM_SELECT_COLUMNS}
      FROM claim_forms
      WHERE workspace_id = ?
      ORDER BY created_at ASC, object_id ASC
    `);

    this.findByStatusStatement = db.connection.prepare(`
      SELECT${CLAIM_FORM_SELECT_COLUMNS}
      FROM claim_forms
      WHERE workspace_id = ?
        AND claim_status = ?
      ORDER BY created_at ASC, object_id ASC
    `);

    this.findByCanonicalKeyStatement = db.connection.prepare(`
      SELECT${CLAIM_FORM_SELECT_COLUMNS}
      FROM claim_forms
      WHERE workspace_id = ?
        AND json_extract(governance_subject, '$.canonical_key') = ?
      ORDER BY created_at ASC, object_id ASC
    `);

    this.updateEvidenceRefsStatement = db.connection.prepare(`
      UPDATE claim_forms
      SET evidence_refs = ?, updated_at = ?
      WHERE object_id = ?
    `);

    this.updateSourceObjectRefsStatement = db.connection.prepare(`
      UPDATE claim_forms
      SET source_object_refs = ?, updated_at = ?
      WHERE object_id = ?
    `);

    // invariant: WHERE clause includes the expected current claim_status
    // so two concurrent transitions racing from the same starting
    // state cannot both win. The first writer flips the status, the
    // second writer's UPDATE finds zero matching rows and the service
    // layer raises CONFLICT.
    this.updateStatusStatement = db.connection.prepare(`
      UPDATE claim_forms
      SET claim_status = ?, updated_at = ?
      WHERE object_id = ? AND claim_status = ?
    `);
  }

  public create(claim: ClaimForm): Readonly<ClaimForm> {
    const parsedClaim = parseClaimForm(claim);

    try {
      this.createStatement.run(
        parsedClaim.object_id,
        parsedClaim.object_kind,
        parsedClaim.schema_version,
        parsedClaim.lifecycle_state,
        parsedClaim.created_at,
        parsedClaim.updated_at,
        parsedClaim.created_by,
        JSON.stringify(parsedClaim.governance_subject),
        parsedClaim.claim_kind,
        parsedClaim.scope_class,
        parsedClaim.enforcement_level,
        parsedClaim.origin_tier,
        parsedClaim.precedence_basis,
        parsedClaim.proposition_digest,
        JSON.stringify(parsedClaim.evidence_refs),
        JSON.stringify(parsedClaim.source_object_refs),
        parsedClaim.workspace_id,
        parsedClaim.claim_status
      );
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to create claim form ${parsedClaim.object_id}.`, error);
    }

    return parsedClaim;
  }

  public async findById(objectId: string): Promise<Readonly<ClaimForm> | null> {
    try {
      const row = this.findByIdStatement.get(objectId) as ClaimFormRow | undefined;
      return row === undefined ? null : parseClaimFormRow(row);
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to load claim form ${objectId}.`, error);
    }
  }

  public async findByIds(objectIds: readonly string[]): Promise<readonly Readonly<ClaimForm>[]> {
    const parsedObjectIds = Array.from(
      new Set(objectIds.map((objectId) => parseNonEmptyString(objectId, "object id")))
    );

    if (parsedObjectIds.length === 0) {
      return [];
    }

    const placeholders = parsedObjectIds.map(() => "?").join(", ");
    const statement = this.db.connection.prepare(`
      SELECT${CLAIM_FORM_SELECT_COLUMNS}
      FROM claim_forms
      WHERE object_id IN (${placeholders})
      ORDER BY created_at ASC, object_id ASC
    `);

    try {
      const rows = statement.all(...parsedObjectIds) as ClaimFormRow[];
      return rows.map((row) => parseClaimFormRow(row));
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to load claim forms by ids.", error);
    }
  }

  public async findByWorkspaceId(workspaceId: string): Promise<readonly Readonly<ClaimForm>[]> {
    try {
      const rows = this.findByWorkspaceIdStatement.all(workspaceId) as ClaimFormRow[];
      return rows.map((row) => parseClaimFormRow(row));
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to list claim forms for workspace ${workspaceId}.`, error);
    }
  }

  public async findByStatus(workspaceId: string, status: ClaimLifecycleState): Promise<readonly Readonly<ClaimForm>[]> {
    const parsedStatus = parseClaimLifecycleState(status);

    try {
      const rows = this.findByStatusStatement.all(workspaceId, parsedStatus) as ClaimFormRow[];
      return rows.map((row) => parseClaimFormRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list claim forms for status ${parsedStatus}.`,
        error
      );
    }
  }

  public async findByCanonicalKey(workspaceId: string, canonicalKey: string): Promise<readonly Readonly<ClaimForm>[]> {
    try {
      const rows = this.findByCanonicalKeyStatement.all(workspaceId, canonicalKey) as ClaimFormRow[];
      return rows.map((row) => parseClaimFormRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list claim forms for canonical key ${canonicalKey}.`,
        error
      );
    }
  }

  public async updateStatus(
    objectId: string,
    status: ClaimLifecycleState,
    updatedAt: string,
    expectedFromStatus: ClaimLifecycleState
  ): Promise<Readonly<ClaimForm>> {
    const parsedStatus = parseClaimLifecycleState(status);
    const parsedFrom = parseClaimLifecycleState(expectedFromStatus);
    const parsedUpdatedAt = parseUpdatedAt(updatedAt);

    try {
      const result = this.updateStatusStatement.run(
        parsedStatus,
        parsedUpdatedAt,
        objectId,
        parsedFrom
      );

      if (result.changes === 0) {
        // invariant: zero rows changed either because the claim does
        // not exist OR another transition raced ahead and the row no
        // longer matches expectedFromStatus. The race case is
        // semantically a conflict, not a not-found.
        const current = await this.findById(objectId);
        if (current === null) {
          throw new StorageError("NOT_FOUND", `Claim form ${objectId} was not found.`);
        }
        throw new StorageError(
          "QUERY_FAILED",
          `Claim form ${objectId} transition expected from ${parsedFrom} but found ${current.claim_status}.`
        );
      }

      const updated = await this.findById(objectId);

      if (updated === null) {
        throw new StorageError("NOT_FOUND", `Claim form ${objectId} was not found after update.`);
      }

      return updated;
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError("QUERY_FAILED", `Failed to update status for claim form ${objectId}.`, error);
    }
  }

  public async clearEvidenceRef(
    objectId: string,
    evidenceRef: string,
    updatedAt: string
  ): Promise<Readonly<ClaimForm>> {
    const claim = await this.requireClaimForm(objectId);
    const parsedEvidenceRef = parseNonEmptyString(evidenceRef, "evidence ref");
    const parsedUpdatedAt = parseUpdatedAt(updatedAt);
    const nextEvidenceRefs = claim.evidence_refs.filter((ref) => ref !== parsedEvidenceRef);

    return await this.updateRefs(
      objectId,
      nextEvidenceRefs,
      parsedUpdatedAt,
      this.updateEvidenceRefsStatement,
      "claim evidence refs"
    );
  }

  public async clearSourceObjectRef(
    objectId: string,
    sourceObjectRef: string,
    updatedAt: string
  ): Promise<Readonly<ClaimForm>> {
    const claim = await this.requireClaimForm(objectId);
    const parsedSourceObjectRef = parseNonEmptyString(sourceObjectRef, "source object ref");
    const parsedUpdatedAt = parseUpdatedAt(updatedAt);
    const nextSourceObjectRefs = claim.source_object_refs.filter((ref) => ref !== parsedSourceObjectRef);

    return await this.updateRefs(
      objectId,
      nextSourceObjectRefs,
      parsedUpdatedAt,
      this.updateSourceObjectRefsStatement,
      "claim source object refs"
    );
  }

  private async requireClaimForm(objectId: string): Promise<Readonly<ClaimForm>> {
    const claim = await this.findById(objectId);

    if (claim === null) {
      throw new StorageError("NOT_FOUND", `Claim form ${objectId} was not found.`);
    }

    return claim;
  }

  private async updateRefs(
    objectId: string,
    refs: readonly string[],
    updatedAt: string,
    statement: { run: (...args: unknown[]) => { changes: number } },
    description: string
  ): Promise<Readonly<ClaimForm>> {
    try {
      const result = statement.run(JSON.stringify(refs), updatedAt, objectId);

      if (result.changes === 0) {
        throw new StorageError("NOT_FOUND", `Claim form ${objectId} was not found.`);
      }

      const updated = await this.findById(objectId);

      if (updated === null) {
        throw new StorageError("NOT_FOUND", `Claim form ${objectId} was not found after update.`);
      }

      return updated;
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError("QUERY_FAILED", `Failed to update ${description} for claim form ${objectId}.`, error);
    }
  }
}

function parseClaimForm(value: ClaimForm): Readonly<ClaimForm> {
  try {
    return deepFreeze(ClaimFormSchema.parse(value));
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate claim form.", error);
  }
}

function parseClaimFormRow(row: ClaimFormRow): Readonly<ClaimForm> {
  try {
    return deepFreeze(
      ClaimFormSchema.parse({
        object_id: row.object_id,
        object_kind: row.object_kind,
        schema_version: row.schema_version,
        lifecycle_state: row.lifecycle_state,
        created_at: row.created_at,
        updated_at: row.updated_at,
        created_by: row.created_by,
        governance_subject: JSON.parse(row.governance_subject),
        claim_kind: row.claim_kind,
        scope_class: row.scope_class,
        enforcement_level: row.enforcement_level,
        origin_tier: row.origin_tier,
        precedence_basis: row.precedence_basis,
        proposition_digest: row.proposition_digest,
        evidence_refs: JSON.parse(row.evidence_refs),
        source_object_refs: JSON.parse(row.source_object_refs),
        workspace_id: row.workspace_id,
        claim_status: row.claim_status
      })
    );
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate claim form row.", error);
  }
}

function parseClaimLifecycleState(value: ClaimLifecycleState): ClaimLifecycleState {
  try {
    return ClaimLifecycleStateSchema.parse(value);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate claim lifecycle state.", error);
  }
}

const parseUpdatedAt = parseTimestamp;
