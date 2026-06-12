import {
  HealthIssueGroupSchema,
  type HealthIssueCauseKindValue,
  type HealthIssueGroup,
  type HealthIssueResolutionStateValue,
  type HealthIssueSuggestedActionValue
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";
import { deepFreeze } from "../shared/deep-freeze.js";

// invariant: HealthIssueGroupRepo is the projection store for the
// Inspector health inbox. Writers upsert by (workspace_id,
// target_object_id, cause_kind); readers paginate by resolution state.
// See protocol-side `HealthIssueGroupSchema` for field semantics.

export interface HealthIssueGroupRepo {
  upsert(group: HealthIssueGroup): Readonly<HealthIssueGroup>;
  findById(groupId: string): Readonly<HealthIssueGroup> | null;
  findByCompositeKey(
    workspaceId: string,
    targetObjectId: string,
    causeKind: HealthIssueCauseKindValue
  ): Readonly<HealthIssueGroup> | null;
  findByWorkspace(
    workspaceId: string,
    options?: {
      readonly state?: HealthIssueResolutionStateValue;
      readonly causeKind?: HealthIssueCauseKindValue;
      readonly limit?: number;
    }
  ): readonly Readonly<HealthIssueGroup>[];
  markResolved(groupId: string, resolvedBy: string, resolvedAt: string): void;
  markSuppressed(groupId: string, suppressedBy: string, occurredAt: string): void;
}

interface HealthIssueGroupRow {
  readonly group_id: string;
  readonly workspace_id: string;
  readonly target_object_id: string;
  readonly target_object_kind: string;
  readonly cause_kind: HealthIssueCauseKindValue;
  readonly severity: "info" | "warn" | "blocking";
  readonly confidence: number;
  readonly first_seen_at: string;
  readonly last_seen_at: string;
  readonly count: number;
  readonly suggested_actions_json: string;
  readonly resolution_state: HealthIssueResolutionStateValue;
  readonly resolved_at: string | null;
  readonly resolved_by: string | null;
}

const SELECT_COLUMNS = `
  group_id,
  workspace_id,
  target_object_id,
  target_object_kind,
  cause_kind,
  severity,
  confidence,
  first_seen_at,
  last_seen_at,
  count,
  suggested_actions_json,
  resolution_state,
  resolved_at,
  resolved_by
`;

export class SqliteHealthIssueGroupRepo implements HealthIssueGroupRepo {
  public constructor(private readonly db: StorageDatabase) {}

  public upsert(group: HealthIssueGroup): Readonly<HealthIssueGroup> {
    const parsed = parseGroup(group);
    try {
      this.db.connection
        .prepare(
          `INSERT INTO health_issue_groups (
            group_id, workspace_id, target_object_id, target_object_kind,
            cause_kind, severity, confidence, first_seen_at, last_seen_at,
            count, suggested_actions_json, resolution_state, resolved_at, resolved_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (workspace_id, target_object_id, cause_kind) DO UPDATE SET
            severity = excluded.severity,
            confidence = excluded.confidence,
            last_seen_at = excluded.last_seen_at,
            count = excluded.count,
            suggested_actions_json = excluded.suggested_actions_json,
            resolution_state = excluded.resolution_state,
            resolved_at = excluded.resolved_at,
            resolved_by = excluded.resolved_by`
        )
        .run(
          parsed.group_id,
          parsed.workspace_id,
          parsed.target_object_id,
          parsed.target_object_kind,
          parsed.cause_kind,
          parsed.severity,
          parsed.confidence,
          parsed.first_seen_at,
          parsed.last_seen_at,
          parsed.count,
          JSON.stringify(parsed.suggested_actions),
          parsed.resolution_state,
          parsed.resolved_at,
          parsed.resolved_by
        );
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to upsert health issue group ${parsed.group_id}.`,
        error
      );
    }

    const row = this.fetchByCompositeKey(
      parsed.workspace_id,
      parsed.target_object_id,
      parsed.cause_kind
    );
    if (row === null) {
      throw new StorageError(
        "NOT_FOUND",
        `Health issue group not found after upsert for ${parsed.target_object_id}.`
      );
    }
    return row;
  }

  public findById(groupId: string): Readonly<HealthIssueGroup> | null {
    try {
      const row = this.db.connection
        .prepare(`SELECT ${SELECT_COLUMNS} FROM health_issue_groups WHERE group_id = ? LIMIT 1`)
        .get(groupId) as HealthIssueGroupRow | undefined;
      return row === undefined ? null : parseRow(row);
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to load health issue group ${groupId}.`, error);
    }
  }

  public findByWorkspace(
    workspaceId: string,
    options: {
      readonly state?: HealthIssueResolutionStateValue;
      readonly causeKind?: HealthIssueCauseKindValue;
      readonly limit?: number;
    } = {}
  ): readonly Readonly<HealthIssueGroup>[] {
    const where: string[] = ["workspace_id = ?"];
    const params: unknown[] = [workspaceId];
    if (options.state !== undefined) {
      where.push("resolution_state = ?");
      params.push(options.state);
    }
    if (options.causeKind !== undefined) {
      where.push("cause_kind = ?");
      params.push(options.causeKind);
    }
    const limit = options.limit ?? 200;
    try {
      const rows = this.db.connection
        .prepare(
          `SELECT ${SELECT_COLUMNS}
           FROM health_issue_groups
           WHERE ${where.join(" AND ")}
           ORDER BY last_seen_at DESC, group_id ASC
           LIMIT ?`
        )
        .all(...params, limit) as HealthIssueGroupRow[];
      return Object.freeze(rows.map(parseRow));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list health issue groups for workspace ${workspaceId}.`,
        error
      );
    }
  }

  public findByCompositeKey(
    workspaceId: string,
    targetObjectId: string,
    causeKind: HealthIssueCauseKindValue
  ): Readonly<HealthIssueGroup> | null {
    return this.fetchByCompositeKey(workspaceId, targetObjectId, causeKind);
  }

  public markResolved(groupId: string, resolvedBy: string, resolvedAt: string): void {
    this.transitionState(groupId, "resolved", resolvedBy, resolvedAt);
  }

  public markSuppressed(groupId: string, suppressedBy: string, occurredAt: string): void {
    this.transitionState(groupId, "suppressed", suppressedBy, occurredAt);
  }

  private transitionState(
    groupId: string,
    state: HealthIssueResolutionStateValue,
    actor: string,
    at: string
  ): void {
    try {
      const result = this.db.connection
        .prepare(
          `UPDATE health_issue_groups
           SET resolution_state = ?, resolved_at = ?, resolved_by = ?
           WHERE group_id = ?`
        )
        .run(state, at, actor, groupId);
      if (result.changes === 0) {
        throw new StorageError(
          "NOT_FOUND",
          `Health issue group ${groupId} was not found.`
        );
      }
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to transition health issue group ${groupId} to ${state}.`,
        error
      );
    }
  }

  private fetchByCompositeKey(
    workspaceId: string,
    targetObjectId: string,
    causeKind: HealthIssueCauseKindValue
  ): Readonly<HealthIssueGroup> | null {
    const row = this.db.connection
      .prepare(
        `SELECT ${SELECT_COLUMNS}
         FROM health_issue_groups
         WHERE workspace_id = ? AND target_object_id = ? AND cause_kind = ?
         LIMIT 1`
      )
      .get(workspaceId, targetObjectId, causeKind) as HealthIssueGroupRow | undefined;
    return row === undefined ? null : parseRow(row);
  }
}

function parseGroup(group: HealthIssueGroup): Readonly<HealthIssueGroup> {
  try {
    return deepFreeze(HealthIssueGroupSchema.parse(group));
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate health issue group.", error);
  }
}

function parseRow(row: HealthIssueGroupRow): Readonly<HealthIssueGroup> {
  let suggestedActions: readonly HealthIssueSuggestedActionValue[];
  try {
    suggestedActions = JSON.parse(row.suggested_actions_json) as readonly HealthIssueSuggestedActionValue[];
  } catch (error) {
    throw new StorageError(
      "VALIDATION_FAILED",
      `Failed to parse suggested_actions_json for health issue group ${row.group_id}.`,
      error
    );
  }
  try {
    return deepFreeze(
      HealthIssueGroupSchema.parse({
        group_id: row.group_id,
        workspace_id: row.workspace_id,
        target_object_id: row.target_object_id,
        target_object_kind: row.target_object_kind,
        cause_kind: row.cause_kind,
        severity: row.severity,
        confidence: row.confidence,
        first_seen_at: row.first_seen_at,
        last_seen_at: row.last_seen_at,
        count: row.count,
        suggested_actions: suggestedActions,
        resolution_state: row.resolution_state,
        resolved_at: row.resolved_at,
        resolved_by: row.resolved_by
      })
    );
  } catch (error) {
    throw new StorageError(
      "VALIDATION_FAILED",
      `Failed to validate health issue group row ${row.group_id}.`,
      error
    );
  }
}
