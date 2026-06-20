import { vi, type Mock } from "vitest";
import {
  RetentionPolicy,
  type EventLogEntry,
  type SessionOverride
} from "@do-soul/alaya-protocol";
import type { SessionOverrideRemediationDependencies } from "../../garden/session-override-remediation.js";

export type RemediationMemoryCreate =
  SessionOverrideRemediationDependencies["memoryService"]["create"];
export type RemediationClaimCreate =
  SessionOverrideRemediationDependencies["claimService"]["create"];
export type RemediationEventLogAppend =
  SessionOverrideRemediationDependencies["eventLogRepo"]["append"];
export type RemediationHasSessionOverridePromotion =
  SessionOverrideRemediationDependencies["eventLogRepo"]["hasSessionOverridePromotion"];
export type RemediationCountDistinctAppliedSessionOverrideRuns =
  SessionOverrideRemediationDependencies["eventLogRepo"]["countDistinctAppliedSessionOverrideRuns"];
export type RemediationResolveDimension = NonNullable<
  SessionOverrideRemediationDependencies["targetObjectResolver"]
>["resolveDimension"];
export type RemediationWarn = NonNullable<SessionOverrideRemediationDependencies["warn"]>;

export function createDeps(
  overrides: Partial<{
    hasSessionOverridePromotion: Mock<RemediationHasSessionOverridePromotion>;
    countDistinctAppliedSessionOverrideRuns: Mock<RemediationCountDistinctAppliedSessionOverrideRuns>;
    resolveDimension: Mock<RemediationResolveDimension>;
    includeResolver: boolean;
  }> = {}
) {
  const storedEvents: EventLogEntry[] = [];
  const warn = vi.fn<RemediationWarn>();

  const deps = {
    memoryService: {
      create: vi.fn<RemediationMemoryCreate>(async () => ({
        object_kind: "memory_entry",
        object_id: "memory-1"
      }))
    },
    claimService: {
      create: vi.fn<RemediationClaimCreate>(async () => ({
        object_kind: "claim_form",
        object_id: "claim-1"
      }))
    },
    eventLogRepo: {
      append: vi.fn<RemediationEventLogAppend>(async (event) => {
        const stored: EventLogEntry = {
          event_id: `event-${storedEvents.length + 1}`,
          created_at: "2026-03-24T00:00:00.000Z",
          revision: 0,
          ...event
        };
        storedEvents.push(stored);
        return stored;
      }),
      hasSessionOverridePromotion:
        overrides.hasSessionOverridePromotion ??
        vi.fn<RemediationHasSessionOverridePromotion>(async (overrideId) =>
          storedEvents.some(
            (event) =>
              event.entity_type === "session_override" &&
              event.entity_id === overrideId &&
              event.event_type === "soul.session_override.promoted"
          )
        ),
      countDistinctAppliedSessionOverrideRuns:
        overrides.countDistinctAppliedSessionOverrideRuns ??
        vi.fn<RemediationCountDistinctAppliedSessionOverrideRuns>(async (query) => {
          const matchingRuns = new Set<string>();
          for (const event of storedEvents) {
            if (event.workspace_id !== query.workspaceId || event.event_type !== "soul.session_override.applied") {
              continue;
            }
            const payload = event.payload_json as Record<string, unknown>;
            if (
              typeof payload.target_object === "string" &&
              typeof payload.correction === "string" &&
              normalizeTriggerValue(payload.target_object) === normalizeTriggerValue(query.targetObject) &&
              normalizeTriggerValue(payload.correction) === normalizeTriggerValue(query.correction) &&
              event.run_id !== null
            ) {
              matchingRuns.add(event.run_id);
            }
          }
          return matchingRuns.size;
        })
    },
    warn
  };

  return {
    ...deps,
    ...(overrides.includeResolver === false
      ? {}
      : {
          targetObjectResolver: {
            resolveDimension:
              overrides.resolveDimension ?? vi.fn<RemediationResolveDimension>(async () => null)
          }
        })
  };
}

function normalizeTriggerValue(value: string): string {
  return value.trim().toLowerCase();
}

export function createOverride(overrides: Partial<SessionOverride> = {}): SessionOverride {
  return {
    runtime_id: "11111111-1111-4111-8111-111111111111",
    object_kind: "session_override",
    task_surface_ref: null,
    expires_at: "2026-03-24T01:00:00.000Z",
    derived_from: "msg-user-1",
    retention_policy: RetentionPolicy.SESSION_ONLY,
    scope: "session_only",
    target_object: "memory:build-style",
    correction: "Use pnpm instead of npm.",
    priority: 2,
    ...overrides
  };
}
