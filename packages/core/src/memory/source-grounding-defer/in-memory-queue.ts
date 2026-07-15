import {
  SOURCE_GROUNDING_DEFER_QUEUE_CAP,
  SOURCE_GROUNDING_DEFER_QUEUE_OVERFLOW_ALLOWANCE,
  isSourceGroundingDeferReason,
  type SourceGroundingDeferEnqueueInput,
  type SourceGroundingDeferEnqueueResult,
  type SourceGroundingDeferEntry,
  type SourceGroundingDeferReason,
  type SourceGroundingDeferStats
} from "@do-soul/alaya-protocol";
import type { SourceGroundingDeferQueueStatePort } from "../source-grounding-defer-queue.js";

type StoredEntry = {
  -readonly [Key in keyof SourceGroundingDeferEntry]: SourceGroundingDeferEntry[Key];
} & { claimToken: string | null };

interface QueueState {
  readonly entries: StoredEntry[];
  readonly lifetime: Map<string, number>;
  readonly cap: number;
}

export function createInMemorySourceGroundingDeferQueue(
  cap = SOURCE_GROUNDING_DEFER_QUEUE_CAP
): SourceGroundingDeferQueueStatePort {
  const state: QueueState = { entries: [], lifetime: new Map(), cap };
  return {
    enqueue: (input) => enqueue(state, input),
    get: (workspaceId, signalId) => readEntry(state, workspaceId, signalId),
    list: (workspaceId, limit = Number.MAX_SAFE_INTEGER) => list(state, workspaceId, limit),
    stats: (workspaceId) => buildStats(state, workspaceId),
    aggregateStats: () => buildStats(state),
    claim: (workspaceId, signalId, token, fingerprint, expiresAt) =>
      claim(state, workspaceId, signalId, token, fingerprint, expiresAt),
    ownsClaim: (workspaceId, signalId, token) =>
      findStored(state, workspaceId, signalId)?.claimToken === token,
    readClaimCapability: (workspaceId, signalId) =>
      readClaimCapability(state, workspaceId, signalId),
    clearExpiredClaim: (input) => clearExpiredClaim(state, input),
    removeClaimed: (workspaceId, signalId, token) =>
      removeClaimed(state, workspaceId, signalId, token)
  };
}

function enqueue(
  state: QueueState,
  input: SourceGroundingDeferEnqueueInput
): SourceGroundingDeferEnqueueResult {
  const entry = newStoredEntry(input);
  bumpReason(state, entry.workspace_id, entry.defer_reason);
  const existingIndex = findIndex(state, entry.workspace_id, entry.signal_id);
  if (existingIndex >= 0) {
    entry.admission_state = state.entries[existingIndex]!.admission_state;
    state.entries.splice(existingIndex, 1, entry);
    return { entry: toPublicEntry(entry), evicted: null };
  }
  const evicted = makeRoom(state, entry.workspace_id);
  const remainingDepth = workspaceEntries(state, entry.workspace_id).length;
  if (remainingDepth >= state.cap) entry.admission_state = "capacity_blocked";
  state.entries.push(entry);
  return { entry: toPublicEntry(entry), evicted };
}

function makeRoom(state: QueueState, workspaceId: string): SourceGroundingDeferEntry | null {
  const workspace = workspaceEntries(state, workspaceId);
  if (workspace.length < state.cap) return null;
  const candidate = workspace.find((entry) => entry.claimToken === null);
  if (candidate === undefined) return null;
  state.entries.splice(findIndex(state, workspaceId, candidate.signal_id), 1);
  return toPublicEntry(candidate);
}

function claim(
  state: QueueState,
  workspaceId: string,
  signalId: string,
  token: string,
  fingerprint: string,
  expiresAt: string
): SourceGroundingDeferEntry | null {
  const entry = findStored(state, workspaceId, signalId);
  if (
    entry === undefined || entry.claimToken !== null || entry.admission_state !== "ready"
  ) return null;
  entry.claimToken = token;
  entry.claim_token_fingerprint = fingerprint;
  entry.claim_expires_at = expiresAt;
  return toPublicEntry(entry);
}

function readClaimCapability(state: QueueState, workspaceId: string, signalId: string) {
  const entry = findStored(state, workspaceId, signalId);
  if (entry === undefined || entry.claimToken === null || entry.claim_expires_at === null) {
    return null;
  }
  return { claimToken: entry.claimToken, claimExpiresAt: entry.claim_expires_at };
}

function clearExpiredClaim(
  state: QueueState,
  input: Parameters<SourceGroundingDeferQueueStatePort["clearExpiredClaim"]>[0]
): boolean {
  const entry = findStored(state, input.workspaceId, input.signalId);
  if (
    entry === undefined || entry.claimToken !== input.claimToken ||
    entry.claim_expires_at !== input.claimExpiresAt || input.claimExpiresAt > input.expiredBefore
  ) return false;
  entry.claimToken = null;
  entry.claim_token_fingerprint = null;
  entry.claim_expires_at = null;
  return true;
}

function removeClaimed(
  state: QueueState,
  workspaceId: string,
  signalId: string,
  token: string
): boolean {
  const index = findIndex(state, workspaceId, signalId);
  if (index < 0 || state.entries[index]?.claimToken !== token) return false;
  state.entries.splice(index, 1);
  promoteOldestBlocked(state, workspaceId);
  return true;
}

function promoteOldestBlocked(state: QueueState, workspaceId: string): void {
  if (workspaceEntries(state, workspaceId).length > state.cap) return;
  const blocked = workspaceEntries(state, workspaceId)
    .find((entry) => entry.admission_state === "capacity_blocked");
  if (blocked !== undefined) blocked.admission_state = "ready";
}

function buildStats(state: QueueState, workspaceId?: string): SourceGroundingDeferStats {
  const entries = workspaceId === undefined ? state.entries : workspaceEntries(state, workspaceId);
  const blocked = entries.filter((entry) => entry.admission_state === "capacity_blocked").length;
  const claimable = entries.filter((entry) =>
    entry.claimToken === null && entry.admission_state === "ready"
  ).length;
  return {
    queue_depth: entries.length,
    queue_cap: state.cap,
    queue_cap_per_workspace: state.cap,
    queue_hard_limit_per_workspace:
      state.cap + SOURCE_GROUNDING_DEFER_QUEUE_OVERFLOW_ALLOWANCE,
    queue_scope: workspaceId === undefined ? "aggregate" : "workspace",
    claimable_depth: claimable,
    capacity_blocked_depth: blocked,
    capacity_state: blocked > 0 ? "saturated" : "ready",
    deferred_by_reason: reasonCounts(state, workspaceId)
  };
}

function reasonCounts(state: QueueState, workspaceId?: string) {
  const counts: Partial<Record<SourceGroundingDeferReason, number>> = {};
  for (const [key, count] of state.lifetime) {
    const [workspace, reason] = key.split("\u0000", 2) as [string, string];
    if (!isSourceGroundingDeferReason(reason) || (workspaceId !== undefined && workspace !== workspaceId)) {
      continue;
    }
    counts[reason] = (counts[reason] ?? 0) + count;
  }
  return counts;
}

function newStoredEntry(input: SourceGroundingDeferEnqueueInput): StoredEntry {
  return {
    signal_id: input.signal_id,
    workspace_id: input.workspace_id,
    run_id: input.run_id,
    defer_reason: input.defer_reason,
    enqueued_at: input.enqueued_at ?? new Date().toISOString(),
    claim_token_fingerprint: null,
    claim_expires_at: null,
    admission_state: "ready",
    claimToken: null
  };
}

function toPublicEntry(entry: StoredEntry): SourceGroundingDeferEntry {
  const { claimToken: _claimToken, ...publicEntry } = entry;
  return publicEntry;
}

function readEntry(state: QueueState, workspaceId: string, signalId: string) {
  const entry = findStored(state, workspaceId, signalId);
  return entry === undefined ? null : toPublicEntry(entry);
}

function list(state: QueueState, workspaceId: string, limit: number) {
  return workspaceEntries(state, workspaceId)
    .slice(0, Math.max(0, limit))
    .map(toPublicEntry);
}

function workspaceEntries(state: QueueState, workspaceId: string): StoredEntry[] {
  return state.entries
    .filter((entry) => entry.workspace_id === workspaceId)
    .sort(compareEntryAge);
}

function compareEntryAge(left: StoredEntry, right: StoredEntry): number {
  return left.enqueued_at.localeCompare(right.enqueued_at) ||
    left.signal_id.localeCompare(right.signal_id);
}

function findStored(state: QueueState, workspaceId: string, signalId: string) {
  return state.entries.find((entry) =>
    entry.workspace_id === workspaceId && entry.signal_id === signalId
  );
}

function findIndex(state: QueueState, workspaceId: string, signalId: string): number {
  return state.entries.findIndex((entry) =>
    entry.workspace_id === workspaceId && entry.signal_id === signalId
  );
}

function bumpReason(state: QueueState, workspaceId: string, reason: SourceGroundingDeferReason) {
  const key = `${workspaceId}\u0000${reason}`;
  state.lifetime.set(key, (state.lifetime.get(key) ?? 0) + 1);
}
