import { randomUUID } from "node:crypto";
import {
  SignalEventType,
  SoulSignalTriagedPayloadSchema,
  type EventLogEntry,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import { KeyedMutex } from "../shared/keyed-mutex.js";

// invariant: ingest-time reconciliation. Decides ADD / UPDATE / NOOP for
// an incoming distilled fact against the top-k lexically-similar existing
// memory_entry rows, before the materialization router appends a new row.
//
// The decision is computed FIRST, before any evidence_capsule or
// memory_entry is created — decide-then-create. The router supplies an
// applyVerdict callback that creates objects per verdict: ADD creates the
// evidence_capsule + memory_entry, UPDATE creates the evidence_capsule
// (so the refined row keeps citing matching evidence), NOOP creates
// nothing. The whole decide -> applyVerdict -> in-place write sequence is
// held under one per-workspace lock so no other reconcile for the same
// workspace can interleave between the decision and the memory write that
// makes a row visible.
//
// The decision is a three-band gate over the FTS pool:
//   - no neighbor above a low similarity floor      -> ADD  (zero LLM)
//   - a normalized-string-identical neighbor        -> NOOP (zero LLM)
//   - any other neighbor at or above the floor      -> LLM-decision port
// The zero-LLM NOOP fires ONLY for a byte-for-byte (normalized) identical
// fact: token-Jaccard is lexically unsound for the drop decision — two
// facts that differ only by a single-char discriminator ("project A" vs
// "project B") share an identical token set and collapse to Jaccard 1.0,
// so any non-identical neighbor above the floor must reach the semantic
// judge instead.
// The LLM is the only sound semantic judge of "refines" vs "distinct":
// a token-superset heuristic merges genuinely distinct facts ("lives in
// Berlin and works in Munich" is a token superset of "lives in Berlin"),
// which is the catastrophic §18 failure mode — wrongly merging a fact
// erases an answer. The LLM is allowed at ingest time (it already runs
// for atomic-fact extraction); it never runs at recall time.
//
// DELETE / supersede is NOT decided here: the existing
// ConflictDetectionService owns contradicts / superseded_by edge
// production at materialization time. Reconciliation only reports
// whether the caller should run that conflict scan.
//
// see also: packages/soul/src/garden/materialization-router/router.ts
//   (ReconciliationPort consumer)
// see also: packages/core/src/governance/conflict-detection-service.ts
//   (DELETE / supersede machinery)
// see also: packages/core/src/memory-service/service.ts:MemoryService.update.
// see also: apps/bench-runner/src/longmemeval/compile-seed.ts
//   (the disk-cached garden-LLM transport this LLM port mirrors)

export type ReconciliationDecisionKind = "add" | "update" | "noop";

export interface ReconciliationDecision {
  /**
   * - `add`: no near-enough existing memory, or the LLM judged the
   *   incoming fact distinct — the router creates the evidence_capsule +
   *   memory_entry.
   * - `update`: the incoming fact refines an existing row; the router
   *   creates the evidence_capsule, then the existing row's `content` is
   *   rewritten in place and that fresh evidence ref is appended to its
   *   `evidence_refs` so durable content keeps matching evidence.
   * - `noop`: a normalized-string-identical duplicate carrying no new
   *   information — nothing is created (no evidence_capsule, no
   *   memory_entry). The drop is audited against the originating signal.
   *
   * For `update` and `noop`, `survivingObjectId` is ALWAYS the id of the
   * row that ends up holding the fact (the UPDATE target, or the NOOP
   * duplicate). The bench scoring sidecar remaps `object_id -> answer
   * turn` through this field; without it a collapsed row's gold id
   * vanishes and recall is undercounted. For `add` it is undefined (the
   * surviving row is the one the caller is about to create).
   */
  readonly kind: ReconciliationDecisionKind;
  readonly survivingObjectId?: string;
  /** @deprecated alias of `survivingObjectId`; kept for the router port. */
  readonly targetObjectId?: string;
  readonly runConflictScan: boolean;
  readonly reason: string;
  /** Best lexical similarity observed against the retrieved top-k. */
  readonly bestSimilarity: number;
}

export interface ReconciliationInput {
  readonly workspaceId: string;
  readonly runId: string;
  readonly signalId: string;
  readonly incomingContent: string;
  readonly incomingDomainTags: readonly string[];
}

// invariant: the per-verdict object-creation callback the router supplies
// to runWithDecision. It runs INSIDE the per-workspace lock, after the
// decision is computed and before any in-place memory write — so the
// evidence_capsule an UPDATE relinks is created on the same critical
// path that decided the verdict. Per verdict the router creates:
//   - add    -> evidence_capsule + memory_entry
//   - update -> evidence_capsule (the refined row keeps matching evidence)
//   - noop   -> nothing
// It returns the freshly created evidence_capsule id for `update` (so the
// core service can relink it); `add` and `noop` return undefined.
export type ReconciliationVerdictApplier = (
  verdict: ReconciliationDecision
) => Promise<{ readonly incomingEvidenceRef?: string }>;

// invariant: lexical FTS retrieval surface. Mirrors
// MemoryEntryRepo.searchByKeyword — top-k lexically similar memory_entry
// rows for a free-text query, workspace-scoped (invariants §29).
export interface ReconciliationKeywordSearchPort {
  searchByKeyword(
    workspaceId: string,
    queryText: string,
    limit: number
  ): Promise<readonly { readonly object_id: string }[]>;
}

export interface ReconciliationMemoryRepoPort {
  findByIds(
    objectIds: readonly string[]
  ): Promise<readonly Readonly<MemoryEntry>[]>;
}

// invariant: in-place UPDATE applier. The reconciliation UPDATE path
// rewrites the existing row's `content`, refreshes its `domain_tags` to
// the refined fact's tags, and extends its `evidence_refs` via
// MemoryService.update, which emits SOUL_MEMORY_UPDATED to the EventLog
// — the auditable mutation path (invariants §13).
export interface ReconciliationMemoryUpdatePort {
  update(
    objectId: string,
    fields: {
      readonly content?: string;
      readonly domain_tags?: readonly string[];
      readonly evidence_refs?: readonly string[];
    },
    reason: string
  ): Promise<Readonly<MemoryEntry>>;
}

// invariant: the EventLog append surface reconciliation needs to audit a
// NOOP drop. A NOOP discards a proposed durable fact; like an UPDATE's
// SOUL_MEMORY_UPDATED, the drop must leave an auditable row. It is
// recorded as SOUL_SIGNAL_TRIAGED triage_result=dropped against the
// originating signal.
export interface ReconciliationEventLogPort {
  append(
    event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">
  ): EventLogEntry | Promise<EventLogEntry>;
}

// invariant: the storage-level advisory-lease port. A multi-process
// reconciliation cannot wrap its LLM round trip in one SQLite
// transaction, so cross-process mutual exclusion is a compare-and-set
// lease instead: tryAcquire INSERTs-OR-CONFLICTs a row keyed by
// workspace_id and wins only when no live lease exists (or the existing
// one is expired and reclaimable). The daemon wires
// SqliteReconciliationLeaseRepo; in a single-process Garden deployment
// the port may be omitted and the in-process KeyedMutex alone suffices.
export interface ReconciliationLeasePort {
  tryAcquire(
    leaseKey: string,
    ownerToken: string,
    nowIso: string,
    expiresAtIso: string
  ): { readonly owner_token: string } | null;
  release(leaseKey: string, ownerToken: string): void;
}

// invariant: the semantic-judge LLM port. Given the incoming fact and
// the ambiguous-band candidate neighbors, returns ADD / UPDATE / NOOP.
// The daemon wires a disk-cached garden-LLM implementation (mirroring
// compile-seed.ts) so re-runs are zero-LLM and repeatable.
// Garden cannot import core; the LLM transport lives in the daemon and
// is injected here, like every other reconciliation port.
export interface ReconciliationLlmDecisionPort {
  decide(input: {
    readonly incomingContent: string;
    readonly candidates: readonly {
      readonly objectId: string;
      readonly content: string;
    }[];
  }): Promise<{
    readonly kind: ReconciliationDecisionKind;
    /** Required for `update` / `noop`: the neighbor objectId acted on. */
    readonly targetObjectId?: string;
    readonly reason?: string;
  }>;
}

// invariant: the rule-only, zero-cloud decision basis. Reconciliation
// must run out of the box without any cloud call (R0 zero-cloud stance:
// the cloud edge-LLM stays default-off). The identity NOOP (dedup) and
// the below-floor ADD are decided in `decide()` BEFORE the port is ever
// consulted, so a rule-only basis only has to resolve the ambiguous band
// — and it resolves it conservatively to ADD: a rule-based UPDATE or
// NOOP on a non-identical neighbor would need the semantic judge to tell
// "refines" from "distinct", and getting that wrong erases an answer
// (the §18 failure mode). ADD never loses a fact. The garden/cloud LLM
// (apps/core-daemon/src/reconciliation-llm-decision.ts) is the OPTIONAL
// upgrade that can resolve the ambiguous band to UPDATE/NOOP; until it is
// configured AND enabled, this rule-only port is the wired default so
// dedup works zero-cloud. It performs no network I/O.
export function createRuleOnlyReconciliationDecisionPort(): ReconciliationLlmDecisionPort {
  return {
    decide: async () => ({
      kind: "add",
      reason: "rule-only reconciliation basis — ambiguous band resolves to ADD (no semantic judge wired)"
    })
  };
}

export interface ReconciliationServiceThresholds {
  /** Below this token-Jaccard similarity no neighbor is close enough to
   *  be worth a semantic check — ADD, zero LLM. A neighbor at or above it
   *  that is not normalized-string-identical reaches the LLM judge. */
  readonly similarityFloor?: number;
  /** Tag-overlap at or above this with a low content-overlap neighbor is
   *  the contradiction signature — caller should run the conflict scan. */
  readonly conflictTagOverlapThreshold?: number;
  /** Top-k retrieval width. */
  readonly topK?: number;
  /** Max ambiguous-band neighbors handed to the LLM judge. */
  readonly maxLlmCandidates?: number;
}

export interface ReconciliationServiceDependencies {
  readonly keywordSearch: ReconciliationKeywordSearchPort;
  readonly memoryRepo: ReconciliationMemoryRepoPort;
  readonly memoryUpdate: ReconciliationMemoryUpdatePort;
  readonly eventLog: ReconciliationEventLogPort;
  readonly llmDecision: ReconciliationLlmDecisionPort;
  readonly thresholds?: ReconciliationServiceThresholds;
  readonly warn?: (message: string, meta: Record<string, unknown>) => void;
  /**
   * Optional shared mutex so a caller can serialize reconciliation
   * across multiple service instances; defaults to a fresh per-instance
   * mutex (sufficient when one instance handles all ingest).
   */
  readonly mutex?: KeyedMutex;
  /**
   * Optional storage-level advisory lease. When wired, the whole
   * decide->write section is additionally guarded by a per-workspace
   * compare-and-set lease so a second daemon (or out-of-process Garden
   * worker) cannot interleave a concurrent reconcile. When omitted, only
   * the in-process KeyedMutex guards — sufficient for a single-process
   * deployment.
   */
  readonly lease?: ReconciliationLeasePort;
  /** Lease TTL in milliseconds; defaults to RECONCILE_LEASE_TTL_MS. */
  readonly leaseTtlMs?: number;
  /** Clock for lease acquire/expiry; defaults to Date.now-backed ISO. */
  readonly now?: () => Date;
}

// Defaults tuned for short distilled facts (≤ DISTILLED_FACT_MAX_CHARS per
// buildDistilledFact). Below the floor the topic barely overlaps and a
// semantic check would be noise; at or above it — unless the fact is
// normalized-string-identical to a neighbor — "refines vs distinct"
// needs the semantic judge.
const DEFAULT_SIMILARITY_FLOOR = 0.35;
const DEFAULT_CONFLICT_TAG_OVERLAP_THRESHOLD = 0.5;
const DEFAULT_TOP_K = 8;
const DEFAULT_MAX_LLM_CANDIDATES = 4;

// invariant: the reconciliation advisory-lease TTL. It MUST outlast the
// slowest single reconciliation pass — most of which is one cold-cache
// LLM `decide()` round trip plus a few async repo writes. Five minutes
// is generous headroom over a worst-case cold call so a still-running
// holder is never reclaimed mid-pass, while still being short enough
// that a crashed holder unwedges ingest within minutes rather than
// indefinitely. The lease is released explicitly in the normal path; the
// TTL is only the crash-recovery backstop.
export const RECONCILE_LEASE_TTL_MS = 5 * 60 * 1000;

// invariant: Jaccard stopword filter. A handful of high-frequency
// function words inflates the overlap between unrelated short facts; a
// near-exact gate at 0.9 is sensitive to that inflation. The list is
// deliberately tiny — only the words that carry zero topical signal.
const STOPWORDS = new Set<string>([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "of",
  "to",
  "in",
  "on",
  "at",
  "and",
  "or",
  "that",
  "this",
  "it",
  "for",
  "with",
  "as",
  "by",
  "user"
]);

export class ReconciliationService {
  private readonly similarityFloor: number;
  private readonly conflictTagOverlapThreshold: number;
  private readonly topK: number;
  private readonly maxLlmCandidates: number;
  private readonly mutex: KeyedMutex;
  private readonly lease?: ReconciliationLeasePort;
  private readonly leaseTtlMs: number;
  private readonly now: () => Date;

  public constructor(private readonly deps: ReconciliationServiceDependencies) {
    const thresholds = deps.thresholds ?? {};
    this.similarityFloor = thresholds.similarityFloor ?? DEFAULT_SIMILARITY_FLOOR;
    this.conflictTagOverlapThreshold =
      thresholds.conflictTagOverlapThreshold ?? DEFAULT_CONFLICT_TAG_OVERLAP_THRESHOLD;
    this.topK = thresholds.topK ?? DEFAULT_TOP_K;
    this.maxLlmCandidates = thresholds.maxLlmCandidates ?? DEFAULT_MAX_LLM_CANDIDATES;
    this.mutex = deps.mutex ?? new KeyedMutex();
    this.lease = deps.lease;
    this.leaseTtlMs = deps.leaseTtlMs ?? RECONCILE_LEASE_TTL_MS;
    this.now = deps.now ?? (() => new Date());
  }

  // invariant: decide-then-create. retrieve -> decide -> applyVerdict ->
  // in-place write runs under one per-workspace keyed async mutex, so a
  // concurrent Garden reconcile for the same workspace cannot interleave
  // between the decision and the memory write that makes a row visible —
  // closing both the both-ADD duplicate race and the lost-UPDATE race.
  //
  // The verdict is computed BEFORE any object exists; `applyVerdict` is
  // the router callback that creates objects per verdict (evidence +
  // memory for ADD, evidence for UPDATE, nothing for NOOP). It runs
  // inside the lock. For UPDATE the callback's freshly created
  // evidence_capsule ref is then relinked into the refined row's
  // evidence_refs; for NOOP the drop is audited; for ADD the callback
  // already created the row and the service does no further write.
  //
  // Trade-off: the LLM `decide()` call runs INSIDE the per-workspace
  // lock. This is deliberate and load-bearing — moving the network
  // round trip outside the lock reopens the both-ADD race, because two
  // concurrent similar facts would each retrieve-see-nothing and both
  // ADD. The cost is per-workspace ingest serialization across the
  // decision; it is acceptable because the lock is in-process (never a
  // DB transaction, so it blocks no DB connection), a cache HIT in the
  // LLM port holds no network call at all, and ingest reconciliation is
  // opt-in. Distinct workspaces never contend.
  //
  // CONCURRENCY SCOPE: two layers guard the decide->write section.
  //   1. `mutex` — a process-local KeyedMutex, in-process defense-in-depth.
  //   2. `lease` — an optional storage-level compare-and-set advisory
  //      lease (reconciliation_leases, INSERT-OR-CONFLICT). It is the
  //      cross-process guard the mutex cannot give: a second daemon or an
  //      out-of-process Garden worker would each pass their own mutex but
  //      only one wins the lease. A true single SQLite transaction is
  //      impossible here — `decide()` contains an un-transactionable LLM
  //      round trip and `applyVerdict` spans several async repo writes —
  //      so the lease is held across the whole section instead, with a TTL
  //      (RECONCILE_LEASE_TTL_MS) and expired-lease reclaim so a crashed
  //      holder cannot wedge ingest. When the lease port is not wired the
  //      mutex alone guards; single-process Garden deployments are correct
  //      either way.
  // If the lease is held by another process the reconcile degrades to a
  // direct ADD — the fact is never lost; the conflict scan reconciles a
  // near-duplicate downstream.
  public async runWithDecision(
    input: ReconciliationInput,
    applyVerdict: ReconciliationVerdictApplier
  ): Promise<ReconciliationDecision> {
    return await this.mutex.runExclusive(input.workspaceId, async () => {
      if (this.lease === undefined) {
        return await this.runDecisionSection(input, applyVerdict);
      }
      const ownerToken = randomUUID();
      const nowDate = this.now();
      const acquired = this.lease.tryAcquire(
        input.workspaceId,
        ownerToken,
        nowDate.toISOString(),
        new Date(nowDate.getTime() + this.leaseTtlMs).toISOString()
      );
      if (acquired === null) {
        // A live reconcile for this workspace is held by another process.
        // Degrade to a direct ADD with a conflict scan rather than block
        // or risk an interleaved decision; the fact stays durable.
        this.warn("reconciliation lease busy — degrading to ADD", {
          workspace_id: input.workspaceId,
          signal_id: input.signalId
        });
        const degraded = addDecision(
          0,
          true,
          "reconciliation lease held by another process — added with conflict scan"
        );
        await applyVerdict(degraded);
        return degraded;
      }
      try {
        return await this.runDecisionSection(input, applyVerdict);
      } finally {
        try {
          this.lease.release(input.workspaceId, ownerToken);
        } catch (error) {
          // A failed release is not fatal: the TTL reclaims the lease.
          this.warn("reconciliation lease release failed", {
            workspace_id: input.workspaceId,
            error: errorMessage(error)
          });
        }
      }
    });
  }

  // invariant: the guarded decide->write critical section. Runs inside
  // both the in-process mutex and (when wired) the storage-level lease —
  // see runWithDecision's CONCURRENCY SCOPE note.
  private async runDecisionSection(
    input: ReconciliationInput,
    applyVerdict: ReconciliationVerdictApplier
  ): Promise<ReconciliationDecision> {
    const decision = await this.decide(input);

    if (decision.kind === "update" && decision.survivingObjectId !== undefined) {
      // UPDATE: the router creates the evidence_capsule first so the
      // refined row can cite it; then the in-place rewrite runs while
      // the lock is still held. If the rewrite cannot be applied the
      // fact must not be lost — degrade to ADD and re-drive the router
      // so it creates the memory_entry instead.
      const { incomingEvidenceRef } = await applyVerdict(decision);
      const applied = await this.applyUpdate(
        decision.survivingObjectId,
        input.incomingContent.trim(),
        input.incomingDomainTags,
        incomingEvidenceRef
      );
      if (applied) {
        return decision;
      }
      const degraded = addDecision(
        decision.bestSimilarity,
        true,
        "LLM UPDATE could not be applied — added with conflict scan"
      );
      await applyVerdict(degraded);
      return degraded;
    }

    if (decision.kind === "noop" && decision.survivingObjectId !== undefined) {
      // NOOP creates nothing — no evidence_capsule, no memory_entry.
      // The verdict is still surfaced to the router for the bench
      // sidecar remap; the router creates no object on this branch.
      await applyVerdict(decision);
      await this.auditDrop(input, decision.survivingObjectId, decision.bestSimilarity);
      return decision;
    }

    // ADD (or an unactionable update/noop without a target): the router
    // creates the evidence_capsule + memory_entry inside the lock.
    await applyVerdict(decision);
    return decision;
  }

  // invariant: the pure decision step — retrieve + classify, no durable
  // write. Runs inside the runWithDecision lock so the verdict and the
  // applyVerdict creation it drives stay on one critical section. An
  // `update` verdict that cannot be applied is caught by applyUpdate
  // returning false; the verdict is recomputed conservatively here only
  // when the LLM judgement itself fails or returns no valid target.
  private async decide(input: ReconciliationInput): Promise<ReconciliationDecision> {
    const incomingContent = input.incomingContent.trim();
    if (incomingContent.length === 0) {
      return addDecision(0, false, "empty incoming content — no reconciliation");
    }

    const neighbors = await this.retrieveNeighbors(input.workspaceId, incomingContent);
    if (neighbors.length === 0) {
      return addDecision(0, false, "no lexically-similar existing memory");
    }

    const incomingTokens = tokenize(incomingContent);
    const incomingTagSet = new Set(input.incomingDomainTags);
    const incomingIdentityKey = normalizeForIdentity(incomingContent);

    let best: { entry: Readonly<MemoryEntry>; similarity: number } | null = null;
    let identical: Readonly<MemoryEntry> | null = null;
    let sawConflictNeighbor = false;
    const ambiguous: { entry: Readonly<MemoryEntry>; similarity: number }[] = [];

    for (const neighbor of neighbors) {
      const similarity = jaccardIndex(incomingTokens, tokenize(neighbor.content));
      if (best === null || similarity > best.similarity) {
        best = { entry: neighbor, similarity };
      }
      // Zero-LLM NOOP fires ONLY for a normalized-string-identical
      // neighbor — Jaccard 1.0 is not identity (a single-char
      // discriminator collapses two distinct facts to the same token
      // set), so a true byte-for-byte match is the only safe drop
      // without the semantic judge.
      if (identical === null && normalizeForIdentity(neighbor.content) === incomingIdentityKey) {
        identical = neighbor;
      }
      if (similarity >= this.similarityFloor) {
        ambiguous.push({ entry: neighbor, similarity });
      }
      // Contradiction signature: shares the topic (tags) but diverges on
      // content. The contradicts / superseded_by edge is produced by
      // ConflictDetectionService — reconciliation only flags it.
      if (
        similarity < this.similarityFloor &&
        jaccardIndex(incomingTagSet, new Set(neighbor.domain_tags)) >=
          this.conflictTagOverlapThreshold
      ) {
        sawConflictNeighbor = true;
      }
    }

    if (best === null) {
      return addDecision(0, sawConflictNeighbor, "no comparable neighbor content");
    }

    // Band 3: a normalized-string-identical neighbor carries no new
    // information — NOOP with zero LLM. Jaccard is deliberately not the
    // gate here (see the loop comment above).
    if (identical !== null) {
      return {
        kind: "noop",
        survivingObjectId: identical.object_id,
        targetObjectId: identical.object_id,
        runConflictScan: false,
        reason: `normalized-string-identical duplicate of ${identical.object_id}`,
        bestSimilarity: best.similarity
      };
    }

    // Band 2: any non-identical neighbor at or above the floor — the LLM
    // is the semantic judge of refines vs distinct. An LLM failure
    // degrades to ADD (never lose a fact) and flags the conflict scan so
    // the divergence is still resolved by ConflictDetectionService.
    if (ambiguous.length > 0) {
      // Highest similarity first so the most plausible refinement target
      // is the LLM's primary candidate; deterministic for cache keying.
      ambiguous.sort((left, right) => right.similarity - left.similarity);
      const candidates = ambiguous
        .slice(0, this.maxLlmCandidates)
        .map((item) => ({ objectId: item.entry.object_id, content: item.entry.content }));
      return await this.decideWithLlm(input, incomingContent, candidates, best.similarity);
    }

    // Band 1: nothing close enough — ADD, zero LLM.
    return addDecision(
      best.similarity,
      sawConflictNeighbor,
      sawConflictNeighbor
        ? "distinct fact with a same-topic divergent neighbor"
        : "distinct fact"
    );
  }

  private async decideWithLlm(
    input: ReconciliationInput,
    incomingContent: string,
    candidates: readonly { readonly objectId: string; readonly content: string }[],
    bestSimilarity: number
  ): Promise<ReconciliationDecision> {
    let verdict: Awaited<ReturnType<ReconciliationLlmDecisionPort["decide"]>>;
    try {
      verdict = await this.deps.llmDecision.decide({ incomingContent, candidates });
    } catch (error) {
      this.warn("reconciliation LLM decision failed — degrading to ADD", {
        signal_id: input.signalId,
        error: errorMessage(error)
      });
      // invariant: a failed semantic judgement must not drop the fact.
      // ADD it and run the conflict scan so a near-duplicate is still
      // reconciled downstream.
      return addDecision(bestSimilarity, true, "LLM decision unavailable — added with conflict scan");
    }

    const candidateIds = new Set(candidates.map((candidate) => candidate.objectId));

    if (verdict.kind === "update") {
      const targetId = verdict.targetObjectId;
      if (targetId === undefined || !candidateIds.has(targetId)) {
        this.warn("reconciliation LLM returned UPDATE without a valid target — degrading to ADD", {
          signal_id: input.signalId,
          target_object_id: targetId ?? null
        });
        return addDecision(bestSimilarity, true, "LLM UPDATE target invalid — added with conflict scan");
      }
      return {
        kind: "update",
        survivingObjectId: targetId,
        targetObjectId: targetId,
        runConflictScan: false,
        reason: verdict.reason ?? `LLM judged a refinement of ${targetId}`,
        bestSimilarity
      };
    }

    if (verdict.kind === "noop") {
      const targetId = verdict.targetObjectId;
      if (targetId === undefined || !candidateIds.has(targetId)) {
        this.warn("reconciliation LLM returned NOOP without a valid target — degrading to ADD", {
          signal_id: input.signalId,
          target_object_id: targetId ?? null
        });
        return addDecision(bestSimilarity, false, "LLM NOOP target invalid — added");
      }
      return {
        kind: "noop",
        survivingObjectId: targetId,
        targetObjectId: targetId,
        runConflictScan: false,
        reason: verdict.reason ?? `LLM judged a duplicate of ${targetId}`,
        bestSimilarity
      };
    }

    // verdict.kind === "add"
    return addDecision(bestSimilarity, false, verdict.reason ?? "LLM judged the fact distinct");
  }

  private async retrieveNeighbors(
    workspaceId: string,
    incomingContent: string
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    let hits: readonly { readonly object_id: string }[];
    try {
      hits = await this.deps.keywordSearch.searchByKeyword(
        workspaceId,
        incomingContent,
        this.topK
      );
    } catch (error) {
      this.warn("reconciliation keyword search failed", {
        workspace_id: workspaceId,
        error: errorMessage(error)
      });
      return [];
    }
    if (hits.length === 0) {
      return [];
    }
    try {
      const entries = await this.deps.memoryRepo.findByIds(
        hits.map((hit) => hit.object_id)
      );
      return entries.filter(
        (entry) =>
          entry.workspace_id === workspaceId && entry.lifecycle_state !== "archived"
      );
    } catch (error) {
      this.warn("reconciliation neighbor fetch failed", {
        workspace_id: workspaceId,
        error: errorMessage(error)
      });
      return [];
    }
  }

  // invariant: an UPDATE rewrites the existing row's `content`,
  // refreshes its `domain_tags` from the refined fact (a stale tag set
  // mis-feeds the conflict-tag signal for the next fact), AND appends
  // the incoming fact's freshly-materialized evidence ref so the refined
  // claim still cites matching evidence and stays reachable via the
  // evidence_fts recall stream. Returns false on any failure so the
  // caller degrades to ADD instead of losing the fact.
  private async applyUpdate(
    targetObjectId: string,
    incomingContent: string,
    incomingDomainTags: readonly string[],
    incomingEvidenceRef: string | undefined
  ): Promise<boolean> {
    try {
      const existing = await this.deps.memoryRepo.findByIds([targetObjectId]);
      const row = existing[0];
      if (row === undefined || row.lifecycle_state === "archived") {
        this.warn("reconciliation update target missing or archived", {
          object_id: targetObjectId
        });
        return false;
      }
      const fields: {
        content: string;
        domain_tags: readonly string[];
        evidence_refs?: readonly string[];
      } = {
        content: incomingContent,
        // The fresh ingest path derives a memory_entry's domain_tags
        // directly from the signal's domain_tags (buildMemoryInput); an
        // in-place refine mirrors that so the row's tags track its
        // current content. see also:
        // packages/soul/src/garden/materialization-router/inputs.ts buildMemoryInput
        domain_tags: incomingDomainTags
      };
      if (incomingEvidenceRef !== undefined && incomingEvidenceRef.trim().length > 0) {
        fields.evidence_refs = row.evidence_refs.includes(incomingEvidenceRef)
          ? row.evidence_refs
          : [...row.evidence_refs, incomingEvidenceRef];
      }
      await this.deps.memoryUpdate.update(
        targetObjectId,
        fields,
        "reconciliation_refine"
      );
      return true;
    } catch (error) {
      this.warn("reconciliation update failed", {
        object_id: targetObjectId,
        error: errorMessage(error)
      });
      return false;
    }
  }

  // invariant: a NOOP drops a proposed durable fact; the drop is
  // auditable. Recorded as SOUL_SIGNAL_TRIAGED triage_result=dropped
  // against the originating signal. The dropped fact's `content` is
  // carried in `caused_by` so a wrong NOOP — especially an LLM-judged
  // one — is reconstructable from the event log alone. An audit-append
  // failure must not change the verdict — the fact is still a true
  // duplicate.
  private async auditDrop(
    input: ReconciliationInput,
    survivingObjectId: string,
    similarity: number
  ): Promise<void> {
    try {
      await this.deps.eventLog.append({
        event_type: SignalEventType.SOUL_SIGNAL_TRIAGED,
        entity_type: "candidate_memory_signal",
        entity_id: input.signalId,
        workspace_id: input.workspaceId,
        run_id: input.runId,
        caused_by: `reconciliation_noop:duplicate_of=${survivingObjectId}:similarity=${similarity.toFixed(3)}:dropped_content=${encodeAuditContent(input.incomingContent)}`,
        payload_json: SoulSignalTriagedPayloadSchema.parse({
          signal_id: input.signalId,
          workspace_id: input.workspaceId,
          run_id: input.runId,
          triage_result: "dropped"
        })
      });
    } catch (error) {
      this.warn("reconciliation NOOP audit append failed", {
        signal_id: input.signalId,
        error: errorMessage(error)
      });
    }
  }

  private warn(message: string, meta: Record<string, unknown>): void {
    this.deps.warn?.(message, meta);
  }
}

function addDecision(
  bestSimilarity: number,
  runConflictScan: boolean,
  reason: string
): ReconciliationDecision {
  return { kind: "add", runConflictScan, reason, bestSimilarity };
}

function tokenize(text: string): Set<string> {
  // Keep single-char alphanumeric tokens — a discriminator like "A" /
  // "B" / "9" carries the entire distinction between two facts and must
  // not be dropped. The split separator already strips pure punctuation,
  // so every surviving non-empty token is a letter/digit/underscore run.
  return new Set(
    text
      .toLowerCase()
      .normalize("NFKC")
      .split(/[^\p{L}\p{N}_]+/u)
      .filter((token) => token.length >= 1 && !STOPWORDS.has(token))
  );
}

// invariant: the normalization used for the zero-LLM NOOP identity gate
// — trim and whitespace-collapse only. Case is NOT folded: a zero-LLM
// drop is irreversible, and case-distinct identifiers ("pod-A" vs
// "pod-a") are genuinely different facts. Two facts equal under this
// normalization are byte-for-byte duplicates modulo whitespace; any
// other near-miss — including a case-only difference — goes to the
// semantic judge.
function normalizeForIdentity(text: string): string {
  return text.trim().replace(/\s+/gu, " ");
}

function jaccardIndex(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 && right.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const value of left) {
    if (right.has(value)) {
      intersection += 1;
    }
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// invariant: the dropped fact's content rides in the NOOP audit row's
// `caused_by` so a wrong drop is reconstructable from the event log
// alone. `caused_by` is colon-delimited (duplicate_of / similarity /
// dropped_content); the content is URI-encoded so a colon or newline in
// the fact text cannot corrupt the delimiter structure, and capped so a
// long fact cannot bloat the audit row unboundedly.
//
// invariant: this cap MUST stay >= DISTILLED_FACT_MAX_CHARS (500) in
// packages/soul/src/garden/materialization-router/router.ts. Every fact that
// reaches reconciliation is a distilled fact already capped at that
// value, so 500 >= 500 guarantees the audit content is never truncated
// and a dropped fact stays fully reconstructable from the event log. If
// the distilled-fact cap is ever raised above 500, this cap must be
// raised in lockstep or the audit silently truncates.
// see also: packages/soul/src/garden/materialization-router/router.ts
//   buildDistilledFact (DISTILLED_FACT_MAX_CHARS)
export const AUDIT_DROPPED_CONTENT_MAX_CHARS = 500;

function encodeAuditContent(content: string): string {
  const trimmed = content.trim();
  const capped =
    trimmed.length <= AUDIT_DROPPED_CONTENT_MAX_CHARS
      ? trimmed
      : trimmed.slice(0, AUDIT_DROPPED_CONTENT_MAX_CHARS);
  return encodeURIComponent(capped);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
