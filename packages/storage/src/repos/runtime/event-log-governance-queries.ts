import {
  GreenGovernanceEventType,
  ObligationTrustNarrativeEventType,
  RevokeReason,
  type EventLogEntry
} from "@do-soul/alaya-protocol";
import { StorageError } from "../../shared/errors.js";
import { parseEventLogEntryRow, type CountRow, type EventLogRow } from "./event-log-rows.js";
import type {
  EventLogGovernancePredicateStatements,
  EventLogRunQueryStatements
} from "./event-log-statement-groups.js";

type ExistsRow = { readonly found: number };

export function normalizeEventLogText(value: string): string {
  return value.trim().toLowerCase();
}

export function executeHasNarrativeConsolidationTrigger(
  statements: Pick<EventLogGovernancePredicateStatements, "hasNarrativeConsolidationTriggerStatement">,
  runId: string,
  digestCountBefore: number
): boolean {
  const row = statements.hasNarrativeConsolidationTriggerStatement.get(
    runId,
    ObligationTrustNarrativeEventType.NARRATIVE_CONSOLIDATION_TRIGGERED,
    digestCountBefore
  ) as ExistsRow | undefined;
  return Number(row?.found ?? 0) > 0;
}

export function executeHasSessionOverridePromotion(
  statements: Pick<EventLogGovernancePredicateStatements, "hasSessionOverridePromotionStatement">,
  overrideId: string
): boolean {
  const row = statements.hasSessionOverridePromotionStatement.get(
    overrideId,
    GreenGovernanceEventType.SOUL_SESSION_OVERRIDE_PROMOTED
  ) as ExistsRow | undefined;
  return Number(row?.found ?? 0) > 0;
}

export function executeCountDistinctAppliedSessionOverrideRuns(
  statements: Pick<
    EventLogGovernancePredicateStatements,
    "countDistinctAppliedSessionOverrideRunsStatement"
  >,
  query: {
    readonly workspaceId: string;
    readonly targetObject: string;
    readonly correction: string;
  }
): number {
  const row = statements.countDistinctAppliedSessionOverrideRunsStatement.get(
    query.workspaceId,
    GreenGovernanceEventType.SOUL_SESSION_OVERRIDE_APPLIED,
    normalizeEventLogText(query.targetObject),
    normalizeEventLogText(query.correction)
  ) as CountRow | undefined;
  return row === undefined ? 0 : Number(row.total);
}

export function executeHasOpenSessionOverrideCorrection(
  statements: Pick<EventLogGovernancePredicateStatements, "hasOpenSessionOverrideCorrectionStatement">,
  query: {
    readonly workspaceId: string;
    readonly targetObjectId: string;
    readonly nowIso: string;
  }
): boolean {
  const row = statements.hasOpenSessionOverrideCorrectionStatement.get(
    query.workspaceId,
    GreenGovernanceEventType.SOUL_SESSION_OVERRIDE_APPLIED,
    query.targetObjectId,
    query.nowIso,
    GreenGovernanceEventType.SOUL_SESSION_OVERRIDE_PROMOTED
  ) as ExistsRow | undefined;
  return Number(row?.found ?? 0) > 0;
}

export function executeHasSecurityHitForTarget(
  statements: Pick<EventLogGovernancePredicateStatements, "hasSecurityHitForTargetStatement">,
  query: {
    readonly workspaceId: string;
    readonly targetObjectId: string;
  }
): boolean {
  const row = statements.hasSecurityHitForTargetStatement.get(
    query.targetObjectId,
    RevokeReason.SECURITY_HIT,
    query.workspaceId,
    GreenGovernanceEventType.SOUL_GREEN_PIERCED,
    query.targetObjectId,
    RevokeReason.SECURITY_HIT
  ) as ExistsRow | undefined;
  return Number(row?.found ?? 0) > 0;
}

export function executeQueryGovernanceLeaseEventsByRun(
  statements: Pick<EventLogRunQueryStatements, "queryGovernanceLeaseEventsByRunStatement">,
  runId: string
): readonly EventLogEntry[] {
  const rows = statements.queryGovernanceLeaseEventsByRunStatement.all(
    runId,
    GreenGovernanceEventType.SOUL_GOVERNANCE_LEASE_ACQUIRED,
    GreenGovernanceEventType.SOUL_GOVERNANCE_LEASE_RELEASED,
    GreenGovernanceEventType.SOUL_GOVERNANCE_LEASE_PIERCED
  ) as EventLogRow[];
  return rows.map((row) => parseEventLogEntryRow(row));
}

export function executeQueryNarrativeDigestPayloadsByRun(
  statements: Pick<EventLogRunQueryStatements, "queryNarrativeDigestPayloadsByRunStatement">,
  runId: string
): readonly Readonly<{ readonly payload_json: unknown }>[] {
  const rows = statements.queryNarrativeDigestPayloadsByRunStatement.all(runId) as ReadonlyArray<{
    readonly payload_json: string;
  }>;
  return rows.map((row) => {
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload_json);
    } catch (error) {
      throw new StorageError("VALIDATION_FAILED", "Failed to parse narrative digest payload JSON.", error);
    }
    return Object.freeze({ payload_json: payload });
  });
}

export function wrapGovernanceQueryError(operation: string, error: unknown): never {
  throw new StorageError("QUERY_FAILED", operation, error);
}
