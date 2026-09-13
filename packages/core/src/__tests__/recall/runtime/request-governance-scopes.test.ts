import { describe, expect, it } from "vitest";
import type { BoundedActiveConstraintsRequest } from "@do-soul/alaya-protocol";
import { encodeAuthorizedScopesAdmission } from "../../../recall/conditional-field/observers/observation-admission.js";
import { sourceRowEligible } from "../../../recall/conditional-field/observers/observation-admission.js";
import { readRequestGovernance } from "../../../recall/runtime/request-governance.js";
import type { ObserveConditionalFieldInput, SourceObserverRow } from "../../../recall/conditional-field/observers/observe.js";

const AS_OF = "2026-09-09T00:00:00.000Z";
const SNAPSHOT = `sha256:${"a".repeat(64)}`;

describe("request governance authorized_scopes tri-state", () => {
  it("agrees with observation admission for null omitted empty and named project", async () => {
    const row: SourceObserverRow = {
      object_id: "mem-global", sourceRevision: "rev-1", lifecycle_state: "active", scope_class: "global_core"
    };
    const budget = {
      schema_version: 1 as const, work_units: 10_000, memory_bytes: 1_000_000,
      page_budget: 100, finalization_reserve: 100, min_envelope: 10
    };
    const cases: ReadonlyArray<{
      readonly authorized_scopes: readonly string[] | null | undefined;
      readonly visible: boolean;
    }> = [
      { authorized_scopes: null, visible: true },
      { authorized_scopes: undefined, visible: false },
      { authorized_scopes: [], visible: false },
      { authorized_scopes: ["project"], visible: false }
    ];
    for (const entry of cases) {
      const observed = sourceRowEligible(
        { as_of: AS_OF, query: { interpretation_clock: AS_OF }, authorized_scopes: entry.authorized_scopes } as unknown as ObserveConditionalFieldInput,
        row
      );
      let captured: BoundedActiveConstraintsRequest | undefined;
      await readRequestGovernance({
        workspace_id: "workspace-1", as_of: AS_OF, snapshot_id: SNAPSHOT, budget,
        authorized_scopes: entry.authorized_scopes
      }, {
        findActiveConstraints: async () => ({ constraints: [], total_count: 0 }),
        readBounded: async (request) => {
          captured = request;
          const denied = request.authorizedScopes === undefined || request.authorizedScopes.mode === "denied"
            || (request.authorizedScopes.mode === "named" && !request.authorizedScopes.scopes.includes("global_core"));
          return {
            constraints: [], total_count: denied ? 0 : 1, completeness: "complete" as const, paths: [],
            temporal_uncertain: false,
            work: { native_visits: 3, bytes_read: 2048, retained_bytes: 2048 },
            binding: {
              workspace_id: request.workspaceId, as_of: request.asOf, snapshot_id: SNAPSHOT,
              authorized_scopes: request.authorizedScopes ?? { mode: "denied" as const }
            }
          };
        }
      }, 20);
      expect(encodeAuthorizedScopesAdmission(entry.authorized_scopes)).toEqual(captured?.authorizedScopes);
      expect(observed).toBe(entry.visible);
      expect(observed).toBe(captured?.authorizedScopes?.mode === "unrestricted");
    }
  });
});
