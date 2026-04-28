import { SlotSchema, type Slot } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../db.js";
import { StorageError } from "../errors.js";
import { deepFreeze } from "./shared/deep-freeze.js";
import { parseNonEmptyString, parseNullableString, parseTimestamp } from "./shared/validators.js";

export interface SlotRepo {
  create(slot: Slot): Promise<Readonly<Slot>>;
  findById(objectId: string): Promise<Readonly<Slot> | null>;
  findByUniqueKey(
    canonicalKey: string,
    claimKind: Slot["claim_kind"],
    scopeClass: Slot["scope_class"],
    workspaceId: string
  ): Promise<Readonly<Slot> | null>;
  findByWorkspace(workspaceId: string): Promise<readonly Readonly<Slot>[]>;
  findByWinnerClaimId(claimId: string): Promise<Readonly<Slot> | null>;
  updateWinner(
    objectId: string,
    winnerClaimId: string | null,
    incumbentSince: string | null,
    updatedAt: string
  ): Promise<Readonly<Slot>>;
}

const SLOT_SELECT_COLUMNS = `
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
        winner_claim_id,
        incumbent_since,
        flip_conditions,
        workspace_id
`;

interface SlotRow {
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
  readonly winner_claim_id: string | null;
  readonly incumbent_since: string | null;
  readonly flip_conditions: string;
  readonly workspace_id: string;
}

export class SqliteSlotRepo implements SlotRepo {
  private readonly createStatement;
  private readonly findByIdStatement;
  private readonly findByUniqueKeyStatement;
  private readonly findByWorkspaceStatement;
  private readonly findByWinnerClaimIdStatement;
  private readonly updateWinnerStatement;

  public constructor(private readonly db: StorageDatabase) {
    this.createStatement = db.connection.prepare(`
      INSERT INTO slots (
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
        winner_claim_id,
        incumbent_since,
        flip_conditions,
        workspace_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.findByIdStatement = db.connection.prepare(`
      SELECT${SLOT_SELECT_COLUMNS}
      FROM slots
      WHERE object_id = ?
      LIMIT 1
    `);

    this.findByUniqueKeyStatement = db.connection.prepare(`
      SELECT${SLOT_SELECT_COLUMNS}
      FROM slots
      WHERE json_extract(governance_subject, '$.canonical_key') = ?
        AND claim_kind = ?
        AND scope_class = ?
        AND workspace_id = ?
      LIMIT 1
    `);

    this.findByWorkspaceStatement = db.connection.prepare(`
      SELECT${SLOT_SELECT_COLUMNS}
      FROM slots
      WHERE workspace_id = ?
      ORDER BY created_at ASC, object_id ASC
    `);

    this.findByWinnerClaimIdStatement = db.connection.prepare(`
      SELECT${SLOT_SELECT_COLUMNS}
      FROM slots
      WHERE winner_claim_id = ?
      LIMIT 1
    `);

    this.updateWinnerStatement = db.connection.prepare(`
      UPDATE slots
      SET winner_claim_id = ?, incumbent_since = ?, updated_at = ?
      WHERE object_id = ?
    `);
  }

  public async create(slot: Slot): Promise<Readonly<Slot>> {
    const parsedSlot = parseSlot(slot);

    try {
      this.createStatement.run(
        parsedSlot.object_id,
        parsedSlot.object_kind,
        parsedSlot.schema_version,
        parsedSlot.lifecycle_state,
        parsedSlot.created_at,
        parsedSlot.updated_at,
        parsedSlot.created_by,
        JSON.stringify(parsedSlot.governance_subject),
        parsedSlot.claim_kind,
        parsedSlot.scope_class,
        parsedSlot.winner_claim_id,
        parsedSlot.incumbent_since,
        JSON.stringify(parsedSlot.flip_conditions),
        parsedSlot.workspace_id
      );
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to create slot ${parsedSlot.object_id}.`, error);
    }

    return parsedSlot;
  }

  public async findById(objectId: string): Promise<Readonly<Slot> | null> {
    try {
      const row = this.findByIdStatement.get(objectId) as SlotRow | undefined;
      return row === undefined ? null : parseSlotRow(row);
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to load slot ${objectId}.`, error);
    }
  }

  public async findByUniqueKey(
    canonicalKey: string,
    claimKind: Slot["claim_kind"],
    scopeClass: Slot["scope_class"],
    workspaceId: string
  ): Promise<Readonly<Slot> | null> {
    const parsedCanonicalKey = parseNonEmptyString(canonicalKey, "canonical key");
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");

    try {
      const row = this.findByUniqueKeyStatement.get(
        parsedCanonicalKey,
        claimKind,
        scopeClass,
        parsedWorkspaceId
      ) as SlotRow | undefined;
      return row === undefined ? null : parseSlotRow(row);
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to load slot by unique key ${parsedCanonicalKey}.`,
        error
      );
    }
  }

  public async findByWorkspace(workspaceId: string): Promise<readonly Readonly<Slot>[]> {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");

    try {
      const rows = this.findByWorkspaceStatement.all(parsedWorkspaceId) as SlotRow[];
      return rows.map((row) => parseSlotRow(row));
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to list slots for workspace ${parsedWorkspaceId}.`, error);
    }
  }

  public async findByWinnerClaimId(claimId: string): Promise<Readonly<Slot> | null> {
    const parsedClaimId = parseNonEmptyString(claimId, "claim id");

    try {
      const row = this.findByWinnerClaimIdStatement.get(parsedClaimId) as SlotRow | undefined;
      return row === undefined ? null : parseSlotRow(row);
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to find slot by winner claim ID ${parsedClaimId}.`,
        error
      );
    }
  }

  public async updateWinner(
    objectId: string,
    winnerClaimId: string | null,
    incumbentSince: string | null,
    updatedAt: string
  ): Promise<Readonly<Slot>> {
    const parsedObjectId = parseNonEmptyString(objectId, "slot object id");
    const parsedWinnerClaimId = parseNullableString(winnerClaimId, "winner claim id");
    const parsedIncumbentSince = incumbentSince === null ? null : parseTimestamp(incumbentSince);
    const parsedUpdatedAt = parseTimestamp(updatedAt);

    try {
      const result = this.updateWinnerStatement.run(
        parsedWinnerClaimId,
        parsedIncumbentSince,
        parsedUpdatedAt,
        parsedObjectId
      );

      if (result.changes === 0) {
        throw new StorageError("NOT_FOUND", `Slot ${parsedObjectId} was not found.`);
      }

      const updated = await this.findById(parsedObjectId);

      if (updated === null) {
        throw new StorageError("NOT_FOUND", `Slot ${parsedObjectId} was not found after update.`);
      }

      return updated;
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError("QUERY_FAILED", `Failed to update winner for slot ${parsedObjectId}.`, error);
    }
  }
}

function parseSlot(value: Slot): Readonly<Slot> {
  try {
    return deepFreeze(SlotSchema.parse(value));
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate slot.", error);
  }
}

function parseSlotRow(row: SlotRow): Readonly<Slot> {
  try {
    return deepFreeze(
      SlotSchema.parse({
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
        winner_claim_id: row.winner_claim_id,
        incumbent_since: row.incumbent_since,
        flip_conditions: JSON.parse(row.flip_conditions),
        workspace_id: row.workspace_id
      })
    );
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate slot row.", error);
  }
}
