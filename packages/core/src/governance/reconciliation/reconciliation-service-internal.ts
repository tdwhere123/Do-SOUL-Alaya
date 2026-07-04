import {
  type EventLogEntry,
  type MemoryEntry
} from "@do-soul/alaya-protocol";

export type { EventLogEntry, MemoryEntry };

import { KeyedMutex } from "../../shared/keyed-mutex.js";
import type { GovernanceRunWorkspaceLookup } from "../policy/run-workspace-guard.js";
import type { PreWriteRecallPort } from "./pre-write-recall-service.js";

export type ReconciliationDecisionKind = "add" | "update" | "noop";

export interface ReconciliationDecision {
  readonly kind: ReconciliationDecisionKind;
  readonly survivingObjectId?: string;
  readonly targetObjectId?: string;
  readonly runConflictScan: boolean;
  readonly reason: string;
  readonly bestSimilarity: number;
}

export interface ReconciliationInput {
  readonly workspaceId: string;
  readonly runId: string;
  readonly signalId: string;
  readonly incomingContent: string;
  readonly incomingDomainTags: readonly string[];
  readonly incomingProjectionFields?: ReconciliationMemoryProjectionFields;
  readonly incomingFacetTags?: MemoryEntry["facet_tags"];
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
  | "canonical_entities"
>;

export type ReconciliationVerdictApplier = (
  verdict: ReconciliationDecision
) => Promise<{ readonly incomingEvidenceRef?: string }>;

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

export interface ReconciliationMemoryUpdatePort {
  update(
    objectId: string,
    fields: {
      readonly content?: string;
      readonly domain_tags?: readonly string[];
      readonly evidence_refs?: readonly string[];
      readonly facet_tags?: MemoryEntry["facet_tags"];
    } & Partial<ReconciliationMemoryProjectionFields>,
    reason: string
  ): Promise<Readonly<MemoryEntry>>;
}

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
  readonly preWriteRecall: PreWriteRecallPort;
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

// invariant: NOOP audit content cap matches the distilled fact cap.
export const AUDIT_DROPPED_CONTENT_MAX_CHARS = 500;

export function auditDroppedContent(content: string): string {
  const trimmed = content.trim();
  return (
    trimmed.length <= AUDIT_DROPPED_CONTENT_MAX_CHARS
      ? trimmed
      : trimmed.slice(0, AUDIT_DROPPED_CONTENT_MAX_CHARS)
  );
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause;
    return cause === undefined ? error.message : `${error.message}: ${errorMessage(cause)}`;
  }
  return String(error);
}
