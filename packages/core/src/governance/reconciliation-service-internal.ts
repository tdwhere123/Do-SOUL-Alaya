import {
  type EventLogEntry,
  type MemoryEntry
} from "@do-soul/alaya-protocol";

export type { EventLogEntry, MemoryEntry };

import { KeyedMutex } from "../shared/keyed-mutex.js";
import type { GovernanceRunWorkspaceLookup } from "./run-workspace-guard.js";

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
// see also: packages/core/src/memory/memory-service/service.ts:MemoryService.update.
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
  readonly incomingProjectionFields?: ReconciliationMemoryProjectionFields;
}

export type ReconciliationMemoryProjectionFields = Pick<
  MemoryEntry,
  | "projection_schema_version"
  | "event_time_start"
  | "event_time_end"
  | "valid_from"
  | "valid_to"
  | "time_precision"
  | "time_source"
  | "preference_subject"
  | "preference_predicate"
  | "preference_object"
  | "preference_category"
  | "preference_polarity"
>;

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
    workspaceId: string,
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
    } & Partial<ReconciliationMemoryProjectionFields>,
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
  readonly runLookup: GovernanceRunWorkspaceLookup;
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
export const DEFAULT_SIMILARITY_FLOOR = 0.35;

export const DEFAULT_CONFLICT_TAG_OVERLAP_THRESHOLD = 0.5;

export const DEFAULT_TOP_K = 8;

export const DEFAULT_MAX_LLM_CANDIDATES = 4;

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

export function addDecision(
  bestSimilarity: number,
  runConflictScan: boolean,
  reason: string
): ReconciliationDecision {
  return { kind: "add", runConflictScan, reason, bestSimilarity };
}

export function tokenize(text: string): Set<string> {
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
export function normalizeForIdentity(text: string): string {
  return text.trim().replace(/\s+/gu, " ");
}

export function jaccardIndex(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
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

export function encodeAuditContent(content: string): string {
  const trimmed = content.trim();
  const capped =
    trimmed.length <= AUDIT_DROPPED_CONTENT_MAX_CHARS
      ? trimmed
      : trimmed.slice(0, AUDIT_DROPPED_CONTENT_MAX_CHARS);
  return encodeURIComponent(capped);
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
