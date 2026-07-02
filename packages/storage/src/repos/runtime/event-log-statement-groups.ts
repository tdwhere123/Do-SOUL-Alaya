import type { StorageDatabase } from "../../sqlite/db.js";

export interface SqliteStatement {
  run(...args: readonly unknown[]): { readonly changes: number };
  get(...args: readonly unknown[]): unknown;
  all(...args: readonly unknown[]): readonly unknown[];
}

type SqlDefinitionMap<T extends object> = { readonly [K in keyof T]: string };
type StatementMap<T extends object> = { -readonly [K in keyof T]: SqliteStatement };

export interface EventLogMutationStatements {
  readonly appendStatement: SqliteStatement;
  readonly deleteByIdStatement: SqliteStatement;
}

export interface EventLogEntityQueryStatements {
  readonly queryByEntityPagedStatement: SqliteStatement;
  readonly queryByTypeStatement: SqliteStatement;
}

export interface EventLogRunQueryStatements {
  readonly queryByRunPagedStatement: SqliteStatement;
  readonly queryByRunAndEntityTypeStatement: SqliteStatement;
  readonly queryConversationMessageEventsByRunPagedStatement: SqliteStatement;
  readonly countConversationMessageEventsByRunStatement: SqliteStatement;
  readonly queryByRunCursorStateStatement: SqliteStatement;
  readonly queryByRunAfterEventIdStatement: SqliteStatement;
  readonly getLatestEventIdStatement: SqliteStatement;
  readonly getLatestMessageTimestampByRunStatement: SqliteStatement;
  readonly getLatestUserRunMessageByRunStatement: SqliteStatement;
  readonly queryByRunAndEventTypeStatement: SqliteStatement;
  readonly queryGovernanceLeaseEventsByRunStatement: SqliteStatement;
  readonly queryNarrativeDigestPayloadsByRunStatement: SqliteStatement;
}

export interface EventLogWorkspaceQueryStatements {
  readonly queryByWorkspacePagedStatement: SqliteStatement;
  readonly queryByWorkspaceAndTypeStatement: SqliteStatement;
  readonly queryByWorkspaceAfterEventIdStatement: SqliteStatement;
  readonly getLatestWorkspaceEventIdStatement: SqliteStatement;
}

export interface EventLogGovernancePredicateStatements {
  readonly hasNarrativeConsolidationTriggerStatement: SqliteStatement;
  readonly hasSessionOverridePromotionStatement: SqliteStatement;
  readonly countDistinctAppliedSessionOverrideRunsStatement: SqliteStatement;
  readonly hasOpenSessionOverrideCorrectionStatement: SqliteStatement;
  readonly hasSecurityHitForTargetStatement: SqliteStatement;
}

export interface EventLogRevisionStatements {
  readonly nextRevisionStatement: SqliteStatement;
}

const EVENT_LOG_SELECT_COLUMNS = `
        event_id,
        event_type,
        entity_type,
        entity_id,
        workspace_id,
        run_id,
        caused_by,
        revision,
        payload_json,
        created_at
`;

const EVENT_LOG_MUTATION_SQL: SqlDefinitionMap<EventLogMutationStatements> = {
  appendStatement: `
      INSERT INTO event_log (
        event_id,
        event_type,
        entity_type,
        entity_id,
        workspace_id,
        run_id,
        caused_by,
        revision,
        payload_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  deleteByIdStatement: "DELETE FROM event_log WHERE event_id = ?"
};

const EVENT_LOG_ENTITY_QUERY_SQL: SqlDefinitionMap<EventLogEntityQueryStatements> = {
  queryByEntityPagedStatement: `
      SELECT${EVENT_LOG_SELECT_COLUMNS}
      FROM event_log
      WHERE entity_type = ? AND entity_id = ?
      ORDER BY created_at ASC, rowid ASC
      LIMIT ? OFFSET ?
    `,
  queryByTypeStatement: `
      SELECT${EVENT_LOG_SELECT_COLUMNS}
      FROM event_log
      WHERE event_type = ?
      ORDER BY created_at ASC, rowid ASC
      LIMIT ? OFFSET ?
    `
};

const EVENT_LOG_RUN_QUERY_SQL: SqlDefinitionMap<EventLogRunQueryStatements> = {
  queryByRunPagedStatement: `
      SELECT${EVENT_LOG_SELECT_COLUMNS}
      FROM event_log
      WHERE run_id = ?
      ORDER BY created_at ASC, rowid ASC
      LIMIT ? OFFSET ?
    `,
  queryByRunAndEntityTypeStatement: `
      SELECT${EVENT_LOG_SELECT_COLUMNS}
      FROM event_log
      WHERE run_id = ? AND entity_type = ?
      ORDER BY created_at ASC, rowid ASC
    `,
  queryConversationMessageEventsByRunPagedStatement: `
      SELECT${EVENT_LOG_SELECT_COLUMNS}
      FROM event_log
      WHERE run_id = ?
        AND event_type IN (?, ?, ?)
      ORDER BY created_at ASC, rowid ASC
      LIMIT ? OFFSET ?
    `,
  countConversationMessageEventsByRunStatement: `
      SELECT COUNT(*) AS total
      FROM event_log
      WHERE run_id = ?
        AND event_type IN (?, ?, ?)
    `,
  queryByRunCursorStateStatement: `
      SELECT
        EXISTS(
          SELECT 1
          FROM event_log
          WHERE run_id = ? AND event_id = ?
          LIMIT 1
        ) AS cursor_exists,
        COALESCE((
          SELECT COUNT(*)
          FROM event_log
          WHERE run_id = ?
            AND rowid <= (
              SELECT rowid
              FROM event_log
              WHERE run_id = ? AND event_id = ?
              LIMIT 1
            )
        ), 0) AS events_up_to_cursor,
        (
          SELECT event_id
          FROM event_log
          WHERE run_id = ?
          ORDER BY created_at DESC, rowid DESC
          LIMIT 1
        ) AS latest_event_id
    `,
  queryByRunAfterEventIdStatement: `
      SELECT${EVENT_LOG_SELECT_COLUMNS}
      FROM event_log
      WHERE run_id = ?
        AND rowid > COALESCE((
          SELECT rowid
          FROM event_log
          WHERE run_id = ? AND event_id = ?
          LIMIT 1
        ), 0)
      ORDER BY created_at ASC, rowid ASC
      LIMIT ? OFFSET ?
    `,
  getLatestEventIdStatement: `
      SELECT event_id
      FROM event_log
      WHERE run_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `,
  getLatestMessageTimestampByRunStatement: `
      SELECT created_at
      FROM event_log
      WHERE run_id = ?
        AND event_type IN (?, ?, ?)
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `,
  getLatestUserRunMessageByRunStatement: `
      SELECT${EVENT_LOG_SELECT_COLUMNS}
      FROM event_log
      WHERE run_id = ?
        AND event_type = ?
        AND json_type(payload_json, '$.role') = 'text'
        AND json_extract(payload_json, '$.role') = 'user'
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `,
  queryByRunAndEventTypeStatement: `
      SELECT${EVENT_LOG_SELECT_COLUMNS}
      FROM event_log
      WHERE run_id = ?
        AND event_type = ?
      ORDER BY created_at ASC, rowid ASC
    `,
  queryGovernanceLeaseEventsByRunStatement: `
      SELECT${EVENT_LOG_SELECT_COLUMNS}
      FROM event_log
      WHERE run_id = ?
        AND event_type IN (?, ?, ?)
      ORDER BY created_at ASC, rowid ASC
    `,
  queryNarrativeDigestPayloadsByRunStatement: `
      SELECT payload_json
      FROM event_log
      WHERE run_id = ?
        AND json_type(payload_json, '$.digest_id') = 'text'
      ORDER BY created_at ASC, rowid ASC
    `
};

const EVENT_LOG_WORKSPACE_QUERY_SQL: SqlDefinitionMap<EventLogWorkspaceQueryStatements> = {
  queryByWorkspacePagedStatement: `
      SELECT${EVENT_LOG_SELECT_COLUMNS}
      FROM event_log
      WHERE workspace_id = ?
      ORDER BY created_at ASC, rowid ASC
      LIMIT ? OFFSET ?
    `,
  queryByWorkspaceAndTypeStatement: `
      SELECT${EVENT_LOG_SELECT_COLUMNS}
      FROM event_log
      WHERE workspace_id = ?
        AND event_type = ?
        AND (
          ? IS NULL
          OR CASE
            WHEN json_type(payload_json, '$.reported_at') = 'text'
              THEN json_extract(payload_json, '$.reported_at')
            ELSE created_at
          END > ?
        )
        AND (
          ? IS NULL
          OR CASE
            WHEN json_type(payload_json, '$.reported_at') = 'text'
              THEN json_extract(payload_json, '$.reported_at')
            ELSE created_at
          END <= ?
        )
        ORDER BY created_at ASC, rowid ASC
      LIMIT ? OFFSET ?
    `,
  queryByWorkspaceAfterEventIdStatement: `
      SELECT${EVENT_LOG_SELECT_COLUMNS}
      FROM event_log
      WHERE workspace_id = ?
        AND rowid > COALESCE((
          SELECT rowid
          FROM event_log
          WHERE workspace_id = ? AND event_id = ?
          LIMIT 1
        ), 0)
      ORDER BY created_at ASC, rowid ASC
      LIMIT ? OFFSET ?
    `,
  getLatestWorkspaceEventIdStatement: `
      SELECT event_id
      FROM event_log
      WHERE workspace_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `
};

const EVENT_LOG_GOVERNANCE_PREDICATE_SQL:
  SqlDefinitionMap<EventLogGovernancePredicateStatements> = {
    hasNarrativeConsolidationTriggerStatement: `
      SELECT EXISTS(
        SELECT 1
        FROM event_log
        WHERE run_id = ?
          AND event_type = ?
          AND json_extract(payload_json, '$.digest_count_before') = ?
        LIMIT 1
      ) AS found
    `,
    hasSessionOverridePromotionStatement: `
      SELECT EXISTS(
        SELECT 1
        FROM event_log
        WHERE entity_type = 'session_override'
          AND entity_id = ?
          AND event_type = ?
        LIMIT 1
      ) AS found
    `,
    countDistinctAppliedSessionOverrideRunsStatement: `
      SELECT COUNT(DISTINCT run_id) AS total
      FROM event_log
      WHERE workspace_id = ?
        AND event_type = ?
        AND run_id IS NOT NULL
        AND json_type(payload_json, '$.target_object') = 'text'
        AND json_type(payload_json, '$.correction') = 'text'
        AND lower(trim(CAST(json_extract(payload_json, '$.target_object') AS TEXT))) = ?
        AND lower(trim(CAST(json_extract(payload_json, '$.correction') AS TEXT))) = ?
    `,
    hasOpenSessionOverrideCorrectionStatement: `
      SELECT EXISTS(
        SELECT 1
        FROM event_log AS applied
        WHERE applied.workspace_id = ?
          AND applied.event_type = ?
          AND json_type(applied.payload_json, '$.override_id') = 'text'
          AND json_type(applied.payload_json, '$.target_object') = 'text'
          AND json_type(applied.payload_json, '$.expires_at') = 'text'
          AND json_extract(applied.payload_json, '$.target_object') = ?
          AND json_extract(applied.payload_json, '$.expires_at') > ?
          AND NOT EXISTS(
            SELECT 1
            FROM event_log AS promoted
            WHERE promoted.workspace_id = applied.workspace_id
              AND promoted.event_type = ?
              AND json_type(promoted.payload_json, '$.override_id') = 'text'
              AND json_type(promoted.payload_json, '$.promotion_outcome') = 'text'
              AND json_extract(promoted.payload_json, '$.override_id') =
                json_extract(applied.payload_json, '$.override_id')
              AND json_extract(promoted.payload_json, '$.promotion_outcome') <> 'not_promoted'
            LIMIT 1
          )
        LIMIT 1
      ) AS found
    `,
    hasSecurityHitForTargetStatement: `
      SELECT (
        EXISTS(
          SELECT 1
          FROM event_log
          WHERE entity_type = 'memory_entry'
            AND entity_id = ?
            AND json_extract(payload_json, '$.revoke_reason') = ?
          LIMIT 1
        )
        OR EXISTS(
          SELECT 1
          FROM event_log
          WHERE workspace_id = ?
            AND event_type = ?
            AND json_extract(payload_json, '$.target_object_id') = ?
            AND json_extract(payload_json, '$.revoke_reason') = ?
          LIMIT 1
        )
      ) AS found
    `
  };

const EVENT_LOG_REVISION_SQL: SqlDefinitionMap<EventLogRevisionStatements> = {
  nextRevisionStatement: `
      SELECT MAX(revision) AS max_revision
      FROM event_log
      WHERE entity_type = ? AND entity_id = ?
    `
};

export function prepareEventLogMutationStatements(db: StorageDatabase): EventLogMutationStatements {
  return prepareStatementGroup(db, EVENT_LOG_MUTATION_SQL);
}

export function prepareEventLogEntityQueryStatements(
  db: StorageDatabase
): EventLogEntityQueryStatements {
  return prepareStatementGroup(db, EVENT_LOG_ENTITY_QUERY_SQL);
}

export function prepareEventLogRunQueryStatements(db: StorageDatabase): EventLogRunQueryStatements {
  return prepareStatementGroup(db, EVENT_LOG_RUN_QUERY_SQL);
}

export function prepareEventLogWorkspaceQueryStatements(
  db: StorageDatabase
): EventLogWorkspaceQueryStatements {
  return prepareStatementGroup(db, EVENT_LOG_WORKSPACE_QUERY_SQL);
}

export function prepareEventLogGovernancePredicateStatements(
  db: StorageDatabase
): EventLogGovernancePredicateStatements {
  return prepareStatementGroup(db, EVENT_LOG_GOVERNANCE_PREDICATE_SQL);
}

export function prepareEventLogRevisionStatements(db: StorageDatabase): EventLogRevisionStatements {
  return prepareStatementGroup(db, EVENT_LOG_REVISION_SQL);
}

function prepareStatementGroup<T extends object>(
  db: StorageDatabase,
  sqlByName: SqlDefinitionMap<T>
): T {
  const statements = {} as StatementMap<T>;
  for (const key of Object.keys(sqlByName) as Array<keyof T>) {
    statements[key] = db.connection.prepare(sqlByName[key]);
  }
  return statements as T;
}
