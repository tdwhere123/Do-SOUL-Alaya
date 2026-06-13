import { describe, expect, it, vi } from "vitest";
import {
  MemoryDimension,
  ScopeClass,
  type EventLogEntry,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import {
  ReconciliationService,
  createRuleOnlyReconciliationDecisionPort,
  type ReconciliationDecision,
  type ReconciliationLlmDecisionPort,
  type ReconciliationServiceDependencies,
  type ReconciliationVerdictApplier
} from "../../governance/reconciliation-service.js";

// invariant: covers the ingest-reconciliation decision contract — the
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

type UpdateFn = ReconciliationServiceDependencies["memoryUpdate"]["update"];
type SearchFn = ReconciliationServiceDependencies["keywordSearch"]["searchByKeyword"];
type AppendFn = ReconciliationServiceDependencies["eventLog"]["append"];
type DecideFn = ReconciliationLlmDecisionPort["decide"];

function createDeps(
  neighbors: readonly MemoryEntry[],
  overrides: Partial<ReconciliationServiceDependencies> = {}
): {
  readonly deps: ReconciliationServiceDependencies;
  readonly update: ReturnType<typeof vi.fn<UpdateFn>>;
  readonly searchByKeyword: ReturnType<typeof vi.fn<SearchFn>>;
  readonly append: ReturnType<typeof vi.fn<AppendFn>>;
  readonly decide: ReturnType<typeof vi.fn<DecideFn>>;
} {
  const findByIds = async (ids: readonly string[]) =>
    neighbors.filter((entry) => ids.includes(entry.object_id));
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
    llmDecision: { decide },
    ...overrides
  };
  return { deps, update, searchByKeyword, append, decide };
}

const baseInput = {
  workspaceId: "workspace-1",
  runId: "run-1",
  signalId: "signal-1"
} as const;

// invariant: drives runWithDecision with an applyVerdict callback that
// stands in for the materialization router — it mints a fresh
// evidence_capsule id on ADD / UPDATE (NOOP creates nothing), exactly
// like the live router. Tracks which verdicts were applied and how many
// evidence capsules were minted so the decide-then-create discipline can
// be asserted.
function drive(
  service: ReconciliationService,
  input: { incomingContent: string; incomingDomainTags: readonly string[] },
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

describe("ReconciliationService", () => {
  it("ADD: appends a genuinely new fact when no similar memory exists", async () => {
    const { deps, update, decide } = createDeps([]);
    const service = new ReconciliationService(deps);

    const driven = drive(service, {
      incomingContent: "The user works as a marine biologist.",
      incomingDomainTags: ["bench-seed"]
    });
    const decision = await driven.decision;

    expect(decision.kind).toBe("add");
    expect(decision.runConflictScan).toBe(false);
    expect(update).not.toHaveBeenCalled();
    // Below the similarity floor — zero LLM call.
    expect(decide).not.toHaveBeenCalled();
    // The router applied an ADD and minted exactly one evidence capsule.
    expect(driven.appliedVerdicts).toEqual(["add"]);
    expect(driven.evidenceMinted()).toBe(1);
  });

  it("ADD: empty incoming content returns early without retrieval", async () => {
    const { deps, searchByKeyword } = createDeps([createMemoryEntry()]);
    const service = new ReconciliationService(deps);

    const decision = await drive(service, {
      incomingContent: "   ",
      incomingDomainTags: ["bench-seed"]
    }).decision;

    expect(decision.kind).toBe("add");
    expect(searchByKeyword).not.toHaveBeenCalled();
  });

  it("ADD: a neighbor below the similarity floor never reaches the LLM", async () => {
    const neighbor = createMemoryEntry({
      content: "The user owns three cats.",
      domain_tags: ["pets"]
    });
    const { deps, decide } = createDeps([neighbor]);
    const service = new ReconciliationService(deps);

    const decision = await drive(service, {
      incomingContent: "The user works as a marine biologist.",
      incomingDomainTags: ["career"]
    }).decision;

    expect(decision.kind).toBe("add");
    expect(decide).not.toHaveBeenCalled();
  });

  it("NOOP: a normalized-string-identical duplicate collapses with zero LLM call and creates nothing", async () => {
    const neighbor = createMemoryEntry({
      content: "The user lives in Berlin.",
      evidence_refs: ["evidence-old"]
    });
    const { deps, update, decide, append } = createDeps([neighbor]);
    const service = new ReconciliationService(deps);

    const driven = drive(service, {
      // Differs only by surrounding whitespace — normalized identity
      // still holds (case is NOT folded).
      incomingContent: "  The user lives in   Berlin.  ",
      incomingDomainTags: ["bench-seed"]
    });
    const decision = await driven.decision;

    expect(decision.kind).toBe("noop");
    expect(decision.survivingObjectId).toBe("memory-existing");
    // NOOP creates nothing: no evidence_capsule minted, no memory write.
    expect(driven.appliedVerdicts).toEqual(["noop"]);
    expect(driven.evidenceMinted()).toBe(0);
    expect(update).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
    // A NOOP drop emits an auditable EventLog row carrying the dropped
    // fact text so a wrong drop is reconstructable.
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0][0].event_type).toBe("soul.signal.triaged");
    expect((append.mock.calls[0][0].payload_json as { triage_result: string }).triage_result).toBe(
      "dropped"
    );
    // The dropped fact text rides in caused_by, trimmed + URI-encoded so
    // the colon-delimited structure cannot be corrupted by the fact text.
    expect(append.mock.calls[0][0].caused_by).toContain(
      `dropped_content=${encodeURIComponent("The user lives in   Berlin.")}`
    );
  });

  it("a genuine ADD followed by a byte-identical re-seed collapses to NOOP and does not grow evidence_refs", async () => {
    // The store starts EMPTY. The first ingest is a genuine ADD that
    // mints exactly one evidence capsule and creates a row; that row is
    // then fed back into the neighbor pool. The second ingest of the
    // byte-identical fact must collapse to a zero-LLM NOOP, mint zero
    // capsules, and never call update — proving idempotent re-seed.
    const store: MemoryEntry[] = [];
    const { deps, update, decide, append } = createDeps(store);
    const service = new ReconciliationService(deps);

    const first = drive(service, {
      incomingContent: "The user lives in Berlin.",
      incomingDomainTags: ["bench-seed"]
    });
    const firstDecision = await first.decision;

    // First ingest: a genuine ADD against an empty store.
    expect(firstDecision.kind).toBe("add");
    expect(first.appliedVerdicts).toEqual(["add"]);
    expect(first.evidenceMinted()).toBe(1);
    expect(decide).not.toHaveBeenCalled();

    // The router created the row — push it into the neighbor pool so the
    // re-seed retrieves it, exactly as the live store would.
    store.push(
      createMemoryEntry({
        object_id: "memory-add-1",
        content: "The user lives in Berlin.",
        domain_tags: ["bench-seed"],
        evidence_refs: ["evidence-add-1"]
      })
    );

    const second = drive(service, {
      incomingContent: "The user lives in Berlin.",
      incomingDomainTags: ["bench-seed"]
    });
    const secondDecision = await second.decision;

    // Second ingest of the identical fact: zero-LLM NOOP against the row
    // the first ADD created.
    expect(secondDecision.kind).toBe("noop");
    expect(secondDecision.survivingObjectId).toBe("memory-add-1");
    expect(second.appliedVerdicts).toEqual(["noop"]);
    expect(second.evidenceMinted()).toBe(0);
    expect(decide).not.toHaveBeenCalled();
    // The surviving row is never written — evidence_refs cannot grow.
    expect(update).not.toHaveBeenCalled();
    expect(store[0]?.evidence_refs).toEqual(["evidence-add-1"]);
    // The re-seed is the only ingest that produced an audit drop.
    expect(append).toHaveBeenCalledTimes(1);
  });

  it("case-distinct identifiers route to the LLM judge — not a silent NOOP", async () => {
    // "pod-A" vs "pod-a" are genuinely different facts; the zero-LLM
    // NOOP gate requires byte-identity (modulo whitespace) and must NOT
    // case-fold. The case-distinct fact reaches the semantic judge
    // instead of being silently dropped.
    const neighbor = createMemoryEntry({
      content: "The active deployment target is pod-A.",
      domain_tags: ["deploy"]
    });
    const { deps, decide } = createDeps([neighbor]);
    decide.mockResolvedValueOnce({ kind: "add", reason: "distinct pod identifier" });
    const service = new ReconciliationService(deps);

    const decision = await drive(service, {
      incomingContent: "The active deployment target is pod-a.",
      incomingDomainTags: ["deploy"]
    }).decision;

    // Routed to the LLM (not collapsed to a zero-LLM NOOP).
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decision.kind).toBe("add");
  });

  it("a near-Jaccard-but-not-identical neighbor routes to the LLM, not a silent NOOP", async () => {
    const neighbor = createMemoryEntry({ content: "The user lives in Berlin" });
    const { deps, decide } = createDeps([neighbor]);
    decide.mockResolvedValueOnce({ kind: "add", reason: "distinct enough" });
    const service = new ReconciliationService(deps);

    const decision = await drive(service, {
      incomingContent: "The user lives in Berlin now",
      incomingDomainTags: ["bench-seed"]
    }).decision;

    expect(decide).toHaveBeenCalledTimes(1);
    expect(decision.kind).toBe("add");
  });

  it("a single-char discriminator pair is NOT collapsed — token set stays distinct", async () => {
    const neighbor = createMemoryEntry({
      content: "The user is admin of project A",
      domain_tags: ["projects"]
    });
    const { deps, decide } = createDeps([neighbor]);
    decide.mockResolvedValueOnce({ kind: "add", reason: "different project" });
    const service = new ReconciliationService(deps);

    const decision = await drive(service, {
      incomingContent: "The user is admin of project B",
      incomingDomainTags: ["projects"]
    }).decision;

    expect(decide).toHaveBeenCalledTimes(1);
    const candidates = decide.mock.calls[0][0].candidates;
    expect(candidates[0]?.content).toBe("The user is admin of project A");
    expect(decision.kind).toBe("add");
  });

  it("a neighbor at or above the floor routes into the LLM ambiguous band", async () => {
    const neighbor = createMemoryEntry({ content: "alpha beta gamma delta" });
    const { deps, decide } = createDeps([neighbor], {
      thresholds: { similarityFloor: 0.5 }
    });
    decide.mockResolvedValueOnce({ kind: "add", reason: "distinct" });
    const service = new ReconciliationService(deps);

    await drive(service, {
      incomingContent: "alpha beta gamma omega epsilon",
      incomingDomainTags: ["bench-seed"]
    }).decision;

    expect(decide).toHaveBeenCalledTimes(1);
  });

  it("ambiguous-band fact: LLM ADD verdict appends without an UPDATE", async () => {
    const neighbor = createMemoryEntry({
      object_id: "memory-neighbor",
      content: "The user lives in Berlin city center"
    });
    const { deps, update, decide } = createDeps([neighbor], {
      thresholds: { similarityFloor: 0.2 }
    });
    decide.mockResolvedValueOnce({ kind: "add", reason: "different attribute" });
    const service = new ReconciliationService(deps);

    const driven = drive(service, {
      incomingContent: "The user lives in Berlin since 2019",
      incomingDomainTags: ["bench-seed"]
    });
    const decision = await driven.decision;

    expect(decide).toHaveBeenCalledTimes(1);
    expect(decision.kind).toBe("add");
    expect(driven.appliedVerdicts).toEqual(["add"]);
    expect(update).not.toHaveBeenCalled();
  });

  it("ambiguous-band fact: LLM UPDATE verdict rewrites content, refreshes tags, relinks evidence", async () => {
    const neighbor = createMemoryEntry({
      object_id: "memory-neighbor",
      content: "The user lives in Berlin city center",
      domain_tags: ["stale-tag"],
      evidence_refs: ["evidence-old"]
    });
    const { deps, update } = createDeps([neighbor], {
      thresholds: { similarityFloor: 0.2 }
    });
    deps.llmDecision.decide = vi.fn<DecideFn>(async () => ({
      kind: "update",
      targetObjectId: "memory-neighbor",
      reason: "refines the residence fact"
    }));
    const service = new ReconciliationService(deps);

    const driven = drive(
      service,
      {
        incomingContent: "The user lives in Berlin since 2019",
        incomingDomainTags: ["residence", "fresh-tag"]
      },
      { evidenceRefForVerdict: () => "evidence-new" }
    );
    const decision = await driven.decision;

    expect(decision.kind).toBe("update");
    expect(decision.survivingObjectId).toBe("memory-neighbor");
    expect(driven.appliedVerdicts).toEqual(["update"]);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0]).toBe("memory-neighbor");
    // Content rewritten, domain_tags refreshed from the new fact, and
    // the freshly-materialized evidence ref appended.
    expect(update.mock.calls[0][1]).toEqual({
      content: "The user lives in Berlin since 2019",
      domain_tags: ["residence", "fresh-tag"],
      evidence_refs: ["evidence-old", "evidence-new"]
    });
  });

  it("ambiguous-band fact: LLM NOOP verdict drops the fact, audits it, creates nothing", async () => {
    const neighbor = createMemoryEntry({
      object_id: "memory-neighbor",
      content: "The user lives in Berlin city center",
      evidence_refs: ["evidence-old"]
    });
    const { deps, update, append } = createDeps([neighbor], {
      thresholds: { similarityFloor: 0.2 }
    });
    deps.llmDecision.decide = vi.fn<DecideFn>(async () => ({
      kind: "noop",
      targetObjectId: "memory-neighbor",
      reason: "equivalent"
    }));
    const service = new ReconciliationService(deps);

    const driven = drive(service, {
      incomingContent: "The user lives in Berlin downtown",
      incomingDomainTags: ["bench-seed"]
    });
    const decision = await driven.decision;

    expect(decision.kind).toBe("noop");
    expect(decision.survivingObjectId).toBe("memory-neighbor");
    expect(append).toHaveBeenCalledTimes(1);
    // The LLM-NOOP creates nothing — no evidence capsule, no memory write.
    expect(driven.evidenceMinted()).toBe(0);
    expect(update).not.toHaveBeenCalled();
    // The LLM-NOOP drop must carry the dropped fact text for recovery.
    expect(append.mock.calls[0][0].caused_by).toContain(
      `dropped_content=${encodeURIComponent("The user lives in Berlin downtown")}`
    );
  });

  it("a max-length distilled fact round-trips through the NOOP audit row untruncated", async () => {
    // The audit cap (AUDIT_DROPPED_CONTENT_MAX_CHARS = 500) must stay at
    // or above the distilled-fact cap (DISTILLED_FACT_MAX_CHARS = 500) so
    // a dropped fact at the longest length the ingest path can produce is
    // still fully reconstructable from caused_by. A 500-char fact must
    // appear in caused_by byte-for-byte after URI-decoding.
    const maxLengthFact = `Berlin ${"x".repeat(493)}`;
    expect(maxLengthFact.length).toBe(500);
    const neighbor = createMemoryEntry({ content: maxLengthFact });
    const { deps, append } = createDeps([neighbor]);
    const service = new ReconciliationService(deps);

    const decision = await drive(service, {
      incomingContent: maxLengthFact,
      incomingDomainTags: ["bench-seed"]
    }).decision;

    expect(decision.kind).toBe("noop");
    expect(append).toHaveBeenCalledTimes(1);
    const causedBy = append.mock.calls[0][0].caused_by ?? "";
    const encoded = causedBy.slice(causedBy.indexOf("dropped_content=") + "dropped_content=".length);
    expect(decodeURIComponent(encoded)).toBe(maxLengthFact);
  });

  it("LLM failure degrades to ADD with the conflict scan flagged", async () => {
    const neighbor = createMemoryEntry({
      object_id: "memory-neighbor",
      content: "The user lives in Berlin city center"
    });
    const { deps, update } = createDeps([neighbor], {
      thresholds: { similarityFloor: 0.2 }
    });
    deps.llmDecision.decide = vi.fn<DecideFn>(async () => {
      throw new Error("garden LLM unavailable");
    });
    const service = new ReconciliationService(deps);

    const decision = await drive(service, {
      incomingContent: "The user lives in Berlin since 2019",
      incomingDomainTags: ["bench-seed"]
    }).decision;

    // Never lose a fact — degrade to ADD and run the conflict scan.
    expect(decision.kind).toBe("add");
    expect(decision.runConflictScan).toBe(true);
    expect(update).not.toHaveBeenCalled();
  });

  it("LLM UPDATE that cannot be applied degrades to ADD with the conflict scan flagged", async () => {
    const neighbor = createMemoryEntry({
      object_id: "memory-neighbor",
      content: "The user lives in Berlin city center"
    });
    const { deps } = createDeps([neighbor], {
      thresholds: { similarityFloor: 0.2 },
      memoryUpdate: {
        update: async () => {
          throw new Error("memory entry is archived");
        }
      }
    });
    deps.llmDecision.decide = vi.fn<DecideFn>(async () => ({
      kind: "update",
      targetObjectId: "memory-neighbor",
      reason: "refines"
    }));
    const service = new ReconciliationService(deps);

    const driven = drive(service, {
      incomingContent: "The user lives in Berlin since 2019",
      incomingDomainTags: ["bench-seed"]
    });
    const decision = await driven.decision;

    expect(decision.kind).toBe("add");
    expect(decision.runConflictScan).toBe(true);
    // applyVerdict is re-driven with the degraded ADD so the router
    // creates the memory_entry it skipped on the failed UPDATE.
    expect(driven.appliedVerdicts).toEqual(["update", "add"]);
  });

  it("LLM UPDATE with an invalid target degrades to ADD", async () => {
    const neighbor = createMemoryEntry({
      object_id: "memory-neighbor",
      content: "The user lives in Berlin city center"
    });
    const { deps, update } = createDeps([neighbor], {
      thresholds: { similarityFloor: 0.2 }
    });
    deps.llmDecision.decide = vi.fn<DecideFn>(async () => ({
      kind: "update",
      targetObjectId: "memory-not-a-candidate",
      reason: "refines"
    }));
    const service = new ReconciliationService(deps);

    const decision = await drive(service, {
      incomingContent: "The user lives in Berlin since 2019",
      incomingDomainTags: ["bench-seed"]
    }).decision;

    expect(decision.kind).toBe("add");
    expect(update).not.toHaveBeenCalled();
  });

  it("multi-neighbor: the highest-similarity neighbor is the LLM's first candidate", async () => {
    const weak = createMemoryEntry({
      object_id: "memory-weak",
      content: "The user lives in Berlin"
    });
    const strong = createMemoryEntry({
      object_id: "memory-strong",
      content: "The user lives in Berlin city center district"
    });
    const { deps, decide } = createDeps([weak, strong], {
      thresholds: { similarityFloor: 0.1 }
    });
    const service = new ReconciliationService(deps);

    await drive(service, {
      incomingContent: "The user lives in Berlin city center near the river",
      incomingDomainTags: ["bench-seed"]
    }).decision;

    expect(decide).toHaveBeenCalledTimes(1);
    const candidates = decide.mock.calls[0][0].candidates;
    expect(candidates[0]?.objectId).toBe("memory-strong");
  });

  it("flags runConflictScan for a same-topic divergent fact below the floor", async () => {
    const neighbor = createMemoryEntry({
      content: "The user prefers tea over coffee.",
      domain_tags: ["beverage-preference"]
    });
    const { deps } = createDeps([neighbor]);
    const service = new ReconciliationService(deps);

    const decision = await drive(service, {
      incomingContent: "The user strongly dislikes every hot drink.",
      incomingDomainTags: ["beverage-preference"]
    }).decision;

    expect(decision.kind).toBe("add");
    expect(decision.runConflictScan).toBe(true);
  });

  it("scopes neighbors to the workspace and skips archived rows", async () => {
    const foreign = createMemoryEntry({
      object_id: "memory-foreign",
      workspace_id: "workspace-other",
      content: "The user lives in Berlin."
    });
    const archived = createMemoryEntry({
      object_id: "memory-archived",
      lifecycle_state: "archived",
      content: "The user lives in Berlin."
    });
    const { deps } = createDeps([foreign, archived]);
    const service = new ReconciliationService(deps);

    const decision = await drive(service, {
      incomingContent: "The user lives in Berlin.",
      incomingDomainTags: ["bench-seed"]
    }).decision;

    expect(decision.kind).toBe("add");
  });

  it("degrades to ADD when keyword search throws", async () => {
    const { deps } = createDeps([], {
      keywordSearch: {
        searchByKeyword: async () => {
          throw new Error("fts unavailable");
        }
      }
    });
    const service = new ReconciliationService(deps);

    const decision = await drive(service, {
      incomingContent: "The user lives in Berlin.",
      incomingDomainTags: ["bench-seed"]
    }).decision;

    expect(decision.kind).toBe("add");
  });

  it("serializes concurrent reconciles for the same workspace", async () => {
    let active = 0;
    let maxActive = 0;
    const neighbor = createMemoryEntry({ content: "unrelated content here" });
    const { deps } = createDeps([neighbor], {
      keywordSearch: {
        searchByKeyword: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return [];
        }
      }
    });
    const service = new ReconciliationService(deps);

    await Promise.all([
      drive(service, { incomingContent: "fact one", incomingDomainTags: [] }).decision,
      drive(service, { incomingContent: "fact two", incomingDomainTags: [] }).decision,
      drive(service, { incomingContent: "fact three", incomingDomainTags: [] }).decision
    ]);

    // The keyed mutex must keep at most one critical section running per
    // workspace key — the decide -> create window stays closed.
    expect(maxActive).toBe(1);
  });
});

describe("ReconciliationService storage-level lease", () => {
  it("acquires and releases the lease around a normal decide->write pass", async () => {
    const { deps } = createDeps([]);
    const acquireCalls: string[] = [];
    const releaseCalls: string[] = [];
    const lease = {
      tryAcquire: (leaseKey: string, ownerToken: string) => {
        acquireCalls.push(`${leaseKey}:${ownerToken}`);
        return { owner_token: ownerToken };
      },
      release: (leaseKey: string, ownerToken: string) => {
        releaseCalls.push(`${leaseKey}:${ownerToken}`);
      }
    };
    const service = new ReconciliationService({ ...deps, lease });

    const driven = drive(service, {
      incomingContent: "The user prefers tabs over spaces.",
      incomingDomainTags: ["bench-seed"]
    });
    const decision = await driven.decision;

    expect(decision.kind).toBe("add");
    expect(acquireCalls).toHaveLength(1);
    // The lease is released after the pass, by the same owner token.
    expect(releaseCalls).toEqual(acquireCalls);
  });

  it("degrades to ADD with a conflict scan when the lease is held by another process", async () => {
    // A neighbor that would normally NOOP — proving the lease-busy path
    // short-circuits BEFORE the decision so it never reaches the gate.
    const neighbor = createMemoryEntry({ content: "The user lives in Berlin." });
    const { deps, decide, searchByKeyword } = createDeps([neighbor]);
    const lease = {
      tryAcquire: () => null,
      release: vi.fn()
    };
    const service = new ReconciliationService({ ...deps, lease });

    const driven = drive(service, {
      incomingContent: "The user lives in Berlin.",
      incomingDomainTags: ["bench-seed"]
    });
    const decision = await driven.decision;

    expect(decision.kind).toBe("add");
    expect(decision.runConflictScan).toBe(true);
    expect(driven.appliedVerdicts).toEqual(["add"]);
    // The decide path was never entered — no retrieval, no LLM judge.
    expect(searchByKeyword).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
    // A lease that was never acquired is never released.
    expect(lease.release).not.toHaveBeenCalled();
  });

  it("releases the lease even when the decide->write pass throws", async () => {
    const { deps } = createDeps([]);
    const releaseCalls: string[] = [];
    const lease = {
      tryAcquire: (leaseKey: string, ownerToken: string) => ({ owner_token: ownerToken }),
      release: (leaseKey: string, ownerToken: string) => {
        releaseCalls.push(`${leaseKey}:${ownerToken}`);
      }
    };
    const service = new ReconciliationService({ ...deps, lease });

    const applyVerdict: ReconciliationVerdictApplier = async () => {
      throw new Error("synthetic applyVerdict failure");
    };

    await expect(
      service.runWithDecision(
        { ...baseInput, incomingContent: "a brand new fact", incomingDomainTags: [] },
        applyVerdict
      )
    ).rejects.toThrow("synthetic applyVerdict failure");
    // The finally block releases the lease so a crash cannot wedge ingest.
    expect(releaseCalls).toHaveLength(1);
  });
});

// invariant: the rule-only, zero-cloud decision basis. Reconciliation
// must dedup out of the box without any cloud/LLM call: the identity
// NOOP and the below-floor ADD are decided before the port is consulted,
// and the ambiguous band resolves conservatively to ADD (never a
// rule-based UPDATE/NOOP — that needs the semantic-judge upgrade). These
// tests wire the real rule-only port behind a spy whose `decide` does no
// network I/O, so any spy invocation is the ambiguous-band path and the
// absence of a real garden-LLM call is asserted by construction.
// see also: packages/core/src/governance/reconciliation-service.ts
//   createRuleOnlyReconciliationDecisionPort
describe("ReconciliationService rule-only (zero-cloud) basis", () => {
  function createRuleOnlyDeps(
    neighbors: readonly MemoryEntry[],
    overrides: Partial<ReconciliationServiceDependencies> = {}
  ): {
    readonly deps: ReconciliationServiceDependencies;
    readonly ruleOnlyDecide: ReturnType<typeof vi.fn<DecideFn>>;
  } {
    const base = createDeps(neighbors, overrides);
    // Wrap the REAL rule-only port in a spy: the spy proves whether the
    // ambiguous band consulted the port at all, while the wrapped real
    // implementation proves the verdict is ADD with no network.
    const realPort = createRuleOnlyReconciliationDecisionPort();
    const ruleOnlyDecide = vi.fn<DecideFn>(realPort.decide);
    const deps: ReconciliationServiceDependencies = {
      ...base.deps,
      llmDecision: { decide: ruleOnlyDecide },
      ...overrides
    };
    return { deps, ruleOnlyDecide };
  }

  it("dedup: a normalized-string-identical fact NOOPs with zero port (and zero network) call", async () => {
    const neighbor = createMemoryEntry({ content: "The user lives in Berlin." });
    const { deps, ruleOnlyDecide } = createRuleOnlyDeps([neighbor]);
    const service = new ReconciliationService(deps);

    const driven = drive(service, {
      incomingContent: "  The user lives in   Berlin.  ",
      incomingDomainTags: ["bench-seed"]
    });
    const decision = await driven.decision;

    // Dedup must work rule-only: the identity NOOP is decided before the
    // port is ever consulted.
    expect(decision.kind).toBe("noop");
    expect(decision.survivingObjectId).toBe("memory-existing");
    expect(driven.appliedVerdicts).toEqual(["noop"]);
    expect(driven.evidenceMinted()).toBe(0);
    expect(ruleOnlyDecide).not.toHaveBeenCalled();
  });

  it("ADD: a novel fact below the floor appends with zero port call", async () => {
    const neighbor = createMemoryEntry({
      content: "The user owns three cats.",
      domain_tags: ["pets"]
    });
    const { deps, ruleOnlyDecide } = createRuleOnlyDeps([neighbor]);
    const service = new ReconciliationService(deps);

    const driven = drive(service, {
      incomingContent: "The user works as a marine biologist.",
      incomingDomainTags: ["career"]
    });
    const decision = await driven.decision;

    expect(decision.kind).toBe("add");
    expect(driven.appliedVerdicts).toEqual(["add"]);
    expect(ruleOnlyDecide).not.toHaveBeenCalled();
  });

  it("ambiguous band: a non-identical above-floor neighbor resolves to ADD, never a rule-based UPDATE/NOOP", async () => {
    const neighbor = createMemoryEntry({
      object_id: "memory-neighbor",
      content: "The user lives in Berlin city center"
    });
    const update = vi.fn<UpdateFn>(async (objectId) => createMemoryEntry({ object_id: objectId }));
    const { deps, ruleOnlyDecide } = createRuleOnlyDeps([neighbor], {
      thresholds: { similarityFloor: 0.2 },
      memoryUpdate: { update }
    });
    const service = new ReconciliationService(deps);

    const driven = drive(service, {
      incomingContent: "The user lives in Berlin since 2019",
      incomingDomainTags: ["bench-seed"]
    });
    const decision = await driven.decision;

    // The ambiguous band consulted the rule-only port — and it resolved
    // to ADD. No rule-based UPDATE (no in-place rewrite) and no NOOP drop.
    expect(ruleOnlyDecide).toHaveBeenCalledTimes(1);
    expect(decision.kind).toBe("add");
    expect(driven.appliedVerdicts).toEqual(["add"]);
    expect(update).not.toHaveBeenCalled();
  });

  it("the rule-only port resolves ADD for any candidate set and performs no I/O", async () => {
    const port = createRuleOnlyReconciliationDecisionPort();
    const verdict = await port.decide({
      incomingContent: "The user lives in Berlin since 2019",
      candidates: [{ objectId: "memory-neighbor", content: "The user lives in Berlin city center" }]
    });
    expect(verdict.kind).toBe("add");
    expect(verdict.targetObjectId).toBeUndefined();
  });

  it("the per-workspace mutex still serializes concurrent reconciles in rule-only mode", async () => {
    let active = 0;
    let maxActive = 0;
    const neighbor = createMemoryEntry({ content: "unrelated content here" });
    const { deps } = createRuleOnlyDeps([neighbor], {
      keywordSearch: {
        searchByKeyword: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return [];
        }
      }
    });
    const service = new ReconciliationService(deps);

    await Promise.all([
      drive(service, { incomingContent: "fact one", incomingDomainTags: [] }).decision,
      drive(service, { incomingContent: "fact two", incomingDomainTags: [] }).decision,
      drive(service, { incomingContent: "fact three", incomingDomainTags: [] }).decision
    ]);

    expect(maxActive).toBe(1);
  });

  it("the storage-level lease still guards the decide->write section in rule-only mode", async () => {
    const neighbor = createMemoryEntry({ content: "The user lives in Berlin." });
    const { deps, ruleOnlyDecide } = createRuleOnlyDeps([neighbor]);
    const lease = {
      tryAcquire: () => null,
      release: vi.fn()
    };
    const service = new ReconciliationService({ ...deps, lease });

    const driven = drive(service, {
      incomingContent: "The user lives in Berlin.",
      incomingDomainTags: ["bench-seed"]
    });
    const decision = await driven.decision;

    // Lease busy short-circuits to ADD before the decide path — the
    // both-ADD race guard is load-bearing in rule-only mode too.
    expect(decision.kind).toBe("add");
    expect(decision.runConflictScan).toBe(true);
    expect(ruleOnlyDecide).not.toHaveBeenCalled();
    expect(lease.release).not.toHaveBeenCalled();
  });
});
