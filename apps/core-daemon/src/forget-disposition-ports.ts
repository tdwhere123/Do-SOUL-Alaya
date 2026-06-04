import { classifyMemoryImportance, isMemoryExplicitlyProtected } from "@do-soul/alaya-core";
import type {
  ForgetDisposition,
  MemoryEntry,
  SynthesisCapsule,
  TransitionCausedBy
} from "@do-soul/alaya-protocol";
import type {
  DormantDispositionCandidate,
  JanitorDispositionSweepPort,
  JanitorTombstoneGcPort,
  TombstonedMemoryRecord
} from "@do-soul/alaya-soul";

// invariant: a synthesis capsule consolidates its subset members ONLY while it is
// live. It carries the cluster's SHARED EVIDENCE (which survives independently as
// evidence_capsules) plus a deterministic gist-level summary forward — it does
// NOT byte-preserve a member's distilled `content`. compress-delete is acceptable
// only for a member FULLY consolidated by a LIVE capsule (its evidence_refs are a
// subset of the capsule's). A tombstoned envelope or an archived synthesis_status
// no longer carries the summary forward, so a member backed only by such a capsule
// is NOT consolidated and must not earn the `compressed` disposition.
function isCapsuleLive(capsule: Readonly<SynthesisCapsule>): boolean {
  return capsule.lifecycle_state !== "tombstone" && capsule.synthesis_status !== "archived";
}

export interface ForgetDispositionMemoryLookupPort {
  findDormantMemories(workspaceId: string): Promise<readonly Readonly<MemoryEntry>[]>;
}

export interface ForgetDispositionCapsuleLookupPort {
  findByWorkspaceId(workspaceId: string): Promise<readonly Readonly<SynthesisCapsule>[]>;
}

export interface ForgetDispositionTombstoneAuthorityPort {
  autonomousTombstone(
    objectId: string,
    disposition: NonNullable<MemoryEntry["forget_disposition"]>,
    dispositionRef: string | null,
    reason: string,
    causedBy: TransitionCausedBy
  ): Promise<Readonly<MemoryEntry>>;
  // invariant: resolves `true` only when the row was physically deleted; `false`
  // on the B1 preservation_revoked fail-closed refuse path (row stays tombstoned).
  autonomousHardDeleteTombstoned(
    objectId: string,
    reason: string,
    causedBy: TransitionCausedBy
  ): Promise<boolean>;
  findTombstonedMemoriesWithDisposition(
    workspaceId: string
  ): Promise<readonly Readonly<MemoryEntry>[]>;
}

/**
 * Computes the durable disposition for a single dormant memory, mechanically and
 * without an LLM. Returns:
 *   - { disposition: null } when the memory is EXPLICITLY PROTECTED (pinned /
 *     hazard / canon / consolidated): it stays dormant (reversible) and is NEVER
 *     autonomously removed, even when it is also a live-capsule member.
 *   - { disposition: 'compressed', ref } when a LIVE capsule lists a NON-protected
 *     member in source_memory_refs (the member is FULLY consolidated by the
 *     capsule: its evidence is the shared cluster evidence preserved as
 *     evidence_capsules + a deterministic gist summary; the member's distilled
 *     `content` is NOT byte-preserved — R3a output).
 *   - { disposition: 'judged_useless', ref: null } when the mechanical importance
 *     gate finds the memory safe to drop (failed ALL keep-criteria).
 *   - { disposition: null } otherwise (preserved-or-kept): stays dormant.
 *
 * invariant (protection-before-compressed): explicit-keep is evaluated BEFORE the
 * `compressed` arm. Compression OVERRIDES ordinary value signals (evidence
 * richness, reinforcement_count — the importance gate's `keep` disposition) but
 * must NEVER override an explicit-keep category, so a pinned/canon/hazard/
 * consolidated memory that happens to sit in a live capsule is left dormant and
 * recoverable rather than marked deletable.
 *
 * see also: packages/core/src/importance-gate.ts isMemoryExplicitlyProtected,
 * classifyMemoryImportance.
 */
export function computeForgetDisposition(
  memory: Readonly<MemoryEntry>,
  liveCapsuleMemberRefs: ReadonlySet<string>
): { readonly disposition: ForgetDisposition | null; readonly ref: string | null } {
  if (isMemoryExplicitlyProtected(memory)) {
    return { disposition: null, ref: null };
  }

  const capsuleRef = liveCapsuleMemberRefs.has(memory.object_id) ? memory.object_id : null;
  if (capsuleRef !== null) {
    // The ref stored is the member's own id resolved against the live capsule.
    return { disposition: "compressed", ref: capsuleRef };
  }

  if (classifyMemoryImportance(memory).disposition === "judged_useless") {
    return { disposition: "judged_useless", ref: null };
  }

  return { disposition: null, ref: null };
}

/**
 * Builds a per-member index from the live capsules in a workspace: member id ->
 * the live capsule id that consolidates it (subset member of source_memory_refs).
 * A member consolidated by more than one live capsule binds to the first by
 * capsule creation order (findByWorkspaceId returns created_at ASC), which is
 * deterministic.
 */
export async function buildLiveCapsuleMemberIndex(
  workspaceId: string,
  capsuleLookup: ForgetDispositionCapsuleLookupPort
): Promise<ReadonlyMap<string, string>> {
  const capsules = await capsuleLookup.findByWorkspaceId(workspaceId);
  const index = new Map<string, string>();
  for (const capsule of capsules) {
    if (!isCapsuleLive(capsule)) {
      continue;
    }
    for (const memberId of capsule.source_memory_refs) {
      if (!index.has(memberId)) {
        index.set(memberId, capsule.object_id);
      }
    }
  }
  return index;
}

/**
 * The GATED autonomous dormant->tombstoned producer wired into the Janitor.
 * Computes each dormant memory's disposition and tombstones (with a durable
 * marker + EventLog audit) only the rows the gate cleared. A null disposition
 * leaves the memory dormant — never terminalized.
 */
export function createTombstoneDispositionSweepPort(input: {
  readonly memoryLookup: ForgetDispositionMemoryLookupPort;
  readonly capsuleLookup: ForgetDispositionCapsuleLookupPort;
  readonly tombstoneAuthority: ForgetDispositionTombstoneAuthorityPort;
  readonly causedBy?: TransitionCausedBy;
}): JanitorDispositionSweepPort {
  const causedBy: TransitionCausedBy = input.causedBy ?? "deterministic_rule";

  return {
    findDormantDispositionCandidates: async (
      workspaceId: string
    ): Promise<readonly DormantDispositionCandidate[]> => {
      const [dormant, memberIndex] = await Promise.all([
        input.memoryLookup.findDormantMemories(workspaceId),
        buildLiveCapsuleMemberIndex(workspaceId, input.capsuleLookup)
      ]);
      const liveCapsuleMembers = new Set(memberIndex.keys());
      return dormant.map((memory) => {
        const verdict = computeForgetDisposition(memory, liveCapsuleMembers);
        const ref =
          verdict.disposition === "compressed"
            ? (memberIndex.get(memory.object_id) ?? null)
            : verdict.ref;
        return {
          memory_id: memory.object_id,
          disposition: verdict.disposition,
          disposition_ref: ref
        };
      });
    },
    autonomousTombstone: async (
      candidate: DormantDispositionCandidate,
      _taskId: string
    ): Promise<void> => {
      // The Janitor only calls this for non-null dispositions; re-assert here so a
      // mis-wired caller can never tombstone an undisposed memory.
      if (candidate.disposition === null) {
        return;
      }
      await input.tombstoneAuthority.autonomousTombstone(
        candidate.memory_id,
        candidate.disposition,
        candidate.disposition_ref,
        "autonomous_forget_sweep",
        causedBy
      );
    }
  };
}

/**
 * The GATED autonomous physical-GC port wired into the Janitor. Lists only
 * tombstoned + past-grace + disposition-bearing rows, and routes each delete
 * through the disposition-gated delete authority (defense in depth: the
 * authority refuses any row lacking a disposition even if tombstoned).
 */
export function createTombstoneGcPort(input: {
  readonly tombstoneAuthority: ForgetDispositionTombstoneAuthorityPort;
  readonly causedBy?: TransitionCausedBy;
}): JanitorTombstoneGcPort {
  const causedBy: TransitionCausedBy = input.causedBy ?? "deterministic_rule";

  return {
    findTombstonedMemories: async (
      workspaceId: string
    ): Promise<readonly TombstonedMemoryRecord[]> => {
      const rows = await input.tombstoneAuthority.findTombstonedMemoriesWithDisposition(workspaceId);
      return rows.map((row) => ({ memory_id: row.object_id }));
    },
    hardDelete: async (memoryId: string, _taskId: string): Promise<boolean> =>
      input.tombstoneAuthority.autonomousHardDeleteTombstoned(
        memoryId,
        "autonomous_tombstone_gc",
        causedBy
      )
  };
}
