import { vi } from "vitest";
import { MemoryDimension, ScopeClass, type EventLogEntry, type MemoryEntry } from "@do-soul/alaya-protocol";
import { ReconciliationService, type ReconciliationDecision, type ReconciliationLlmDecisionPort, type ReconciliationServiceDependencies, type ReconciliationVerdictApplier } from "../../governance/reconciliation-service.js";

export // invariant: covers the ingest-reconciliation decision contract — the
// three-band gate (ADD below the floor, NOOP for a normalized-string-
// identical neighbor, LLM judge for any other neighbor at or above the
// floor), the LLM port returning each of ADD / UPDATE / NOOP, the
// LLM-failure degrade-to-ADD path, the evidence relink + domain_tags
// refresh on UPDATE, the NOOP audit-event emission, and the decide-then-
// create discipline (NOOP creates no evidence_capsule; a re-seed of the
// same fact does not grow the surviving row's evidence_refs).
// see also: packages/core/src/governance/reconciliation-service.ts

function createMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: "memory-existing",
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-05-16T00:00:00.000Z",
    updated_at: "2026-05-16T00:00:00.000Z",
    created_by: "test",
    dimension: MemoryDimension.FACT,
    source_kind: "compiler",
    formation_kind: "extracted",
    scope_class: ScopeClass.PROJECT,
    content: "The user lives in Berlin.",
    domain_tags: ["bench-seed"],
    evidence_refs: ["evidence-1"],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: "hot",
    activation_score: 0.6,
    retention_score: 0.6,
    manifestation_state: "excerpt",
    retention_state: "working",
    decay_profile: "stable",
    confidence: 0.9,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: 0,
    contradiction_count: 0,
    superseded_by: null,
    ...overrides
  };
}

export type UpdateFn = ReconciliationServiceDependencies["memoryUpdate"]["update"];

export type SearchFn = ReconciliationServiceDependencies["keywordSearch"]["searchByKeyword"];

export type AppendFn = ReconciliationServiceDependencies["eventLog"]["append"];

export type DecideFn = ReconciliationLlmDecisionPort["decide"];

export function createDeps(
  neighbors: readonly MemoryEntry[],
  overrides: Partial<ReconciliationServiceDependencies> = {}
): {
  readonly deps: ReconciliationServiceDependencies;
  readonly update: ReturnType<typeof vi.fn<UpdateFn>>;
  readonly searchByKeyword: ReturnType<typeof vi.fn<SearchFn>>;
  readonly append: ReturnType<typeof vi.fn<AppendFn>>;
  readonly decide: ReturnType<typeof vi.fn<DecideFn>>;
} {
  const findByIds = async (workspaceId: string, ids: readonly string[]) =>
    neighbors.filter((entry) => entry.workspace_id === workspaceId && ids.includes(entry.object_id));
  const update = vi.fn<UpdateFn>(async (objectId, fields) =>
    createMemoryEntry({
      object_id: objectId,
      ...(fields.content === undefined ? {} : { content: fields.content }),
      ...(fields.domain_tags === undefined ? {} : { domain_tags: [...fields.domain_tags] }),
      ...(fields.evidence_refs === undefined ? {} : { evidence_refs: [...fields.evidence_refs] })
    })
  );
  const searchByKeyword = vi.fn<SearchFn>(async () =>
    neighbors.map((entry) => ({ object_id: entry.object_id }))
  );
  const append = vi.fn<AppendFn>(
    async (event) => ({ ...event, event_id: "event-1", created_at: "2026-05-16T00:00:00.000Z", revision: 0 }) as EventLogEntry
  );
  const decide = vi.fn<DecideFn>(async () => ({ kind: "add" as const, reason: "distinct" }));
	  const deps: ReconciliationServiceDependencies = {
	    keywordSearch: { searchByKeyword },
	    memoryRepo: { findByIds },
	    memoryUpdate: { update },
	    eventLog: { append },
	    runLookup: {
	      getById: async (runId) =>
	        runId === "run-1" ? { workspace_id: "workspace-1" } : null
	    },
	    llmDecision: { decide },
	    ...overrides
	  };
  return { deps, update, searchByKeyword, append, decide };
}

export const baseInput = {
  workspaceId: "workspace-1",
  runId: "run-1",
  signalId: "signal-1"
} as const;

export // invariant: drives runWithDecision with an applyVerdict callback that
// stands in for the materialization router — it mints a fresh
// evidence_capsule id on ADD / UPDATE (NOOP creates nothing), exactly
// like the live router. Tracks which verdicts were applied and how many
// evidence capsules were minted so the decide-then-create discipline can
// be asserted.
function drive(
  service: ReconciliationService,
  input: {
    incomingContent: string;
    incomingDomainTags: readonly string[];
    incomingProjectionFields?: Parameters<ReconciliationService["runWithDecision"]>[0]["incomingProjectionFields"];
  },
  options: { evidenceRefForVerdict?: (kind: string) => string } = {}
): {
  readonly decision: Promise<ReconciliationDecision>;
  readonly appliedVerdicts: string[];
  readonly evidenceMinted: () => number;
} {
  const appliedVerdicts: string[] = [];
  let evidenceCounter = 0;
  const applyVerdict: ReconciliationVerdictApplier = async (verdict) => {
    appliedVerdicts.push(verdict.kind);
    if (verdict.kind === "noop") {
      return {};
    }
    evidenceCounter += 1;
    const ref =
      options.evidenceRefForVerdict?.(verdict.kind) ?? `evidence-mint-${evidenceCounter}`;
    return { incomingEvidenceRef: ref };
  };
  return {
    decision: service.runWithDecision({ ...baseInput, ...input }, applyVerdict),
    appliedVerdicts,
    evidenceMinted: () => evidenceCounter
  };
}
