import { classifyMemoryImportance, CoreError, isMemoryExplicitlyProtected } from "@do-soul/alaya-core";
import type {
  ForgetDisposition,
  MemoryEntry,
  SynthesisCapsule,
  TransitionCausedBy
} from "@do-soul/alaya-protocol";
import type {
  DispositionSweepOutcome,
  DormantDispositionCandidate,
  JanitorDispositionSweepPort,
  JanitorTombstoneGcPort,
  TombstonedMemoryRecord
} from "@do-soul/alaya-soul";

// Live membership nominates a capsule only. Core must adopt a complete historical
// capture in the guarded terminal transaction; a summary/evidence subset is not preservation.
function isCapsuleLive(capsule: Readonly<SynthesisCapsule>): boolean {
  return capsule.lifecycle_state !== "tombstone" && capsule.synthesis_status !== "archived";
}

export interface ForgetDispositionMemoryLookupPort {
  findDormantMemories(workspaceId: string): Promise<readonly Readonly<MemoryEntry>[]>;
  // invariant: single-row re-load used ONLY to confirm a benign concurrent-mutation
  // race when the tombstone authority refuses a candidate (row no longer dormant /
  // became explicitly protected). It is not a recall path. Resolves null when the
  // row left existence entirely (also a benign race for the sweep).
  findById(objectId: string): Promise<Readonly<MemoryEntry> | null>;
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

/** Nominate a disposition, never a preservation certificate. Explicit protections
 * precede compression nominations; the judged-useless value policy is unchanged.
 * A compressed nomination remains dormant when Core cannot establish complete
 * source-bound historical retention. Capturing exact material is not a claim of
 * semantic compression or storage savings.
 */
export function computeForgetDisposition(
  memory: Readonly<MemoryEntry>,
  liveCapsuleMemberIndex: ReadonlyMap<string, string>
): { readonly disposition: ForgetDisposition | null; readonly ref: string | null } {
  if (isMemoryExplicitlyProtected(memory)) {
    return { disposition: null, ref: null };
  }

  const capsuleRef = liveCapsuleMemberIndex.get(memory.object_id) ?? null;
  if (capsuleRef !== null) {
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
    ): Promise<readonly DormantDispositionCandidate[]> =>
      await findDormantDispositionCandidates(input, workspaceId),
    autonomousTombstone: async (
      candidate: DormantDispositionCandidate,
      _taskId: string
    ): Promise<DispositionSweepOutcome> =>
      await autonomousTombstoneDispositionCandidate(
        input,
        causedBy,
        candidate
      )
  };
}

async function findDormantDispositionCandidates(
  input: Readonly<{
    readonly memoryLookup: ForgetDispositionMemoryLookupPort;
    readonly capsuleLookup: ForgetDispositionCapsuleLookupPort;
  }>,
  workspaceId: string
): Promise<readonly DormantDispositionCandidate[]> {
  const [dormant, memberIndex] = await Promise.all([
    input.memoryLookup.findDormantMemories(workspaceId),
    buildLiveCapsuleMemberIndex(workspaceId, input.capsuleLookup)
  ]);
  return dormant.map((memory) => {
    const verdict = computeForgetDisposition(memory, memberIndex);
    return {
      memory_id: memory.object_id,
      disposition: verdict.disposition,
      disposition_ref: verdict.ref
    };
  });
}

async function autonomousTombstoneDispositionCandidate(
  input: Readonly<{
    readonly memoryLookup: ForgetDispositionMemoryLookupPort;
    readonly tombstoneAuthority: ForgetDispositionTombstoneAuthorityPort;
  }>,
  causedBy: TransitionCausedBy,
  candidate: DormantDispositionCandidate
): Promise<DispositionSweepOutcome> {
  if (candidate.disposition === null) {
    return { status: "skipped", reason: "null disposition (kept)" };
  }
  try {
    await input.tombstoneAuthority.autonomousTombstone(
      candidate.memory_id,
      candidate.disposition,
      candidate.disposition_ref,
      "autonomous_forget_sweep",
      causedBy
    );
    return { status: "tombstoned" };
  } catch (error) {
    const benignReason = await classifyBenignTombstoneRefusal(
      input.memoryLookup,
      candidate.memory_id,
      error
    );
    if (benignReason === null) {
      throw error;
    }
    return { status: "skipped", reason: benignReason };
  }
}

async function classifyBenignTombstoneRefusal(
  memoryLookup: ForgetDispositionMemoryLookupPort,
  objectId: string,
  error: unknown
): Promise<string | null> {
  if (!(error instanceof CoreError) || error.code !== "VALIDATION") {
    return null;
  }
  if (error.subCode === "PRESERVATION_INELIGIBLE") return "independent historical preservation unavailable (kept)";
  return await classifyTombstoneRefusal(memoryLookup, objectId);
}

// invariant: re-loads the refused row to confirm whether the refusal is a benign
// concurrent-mutation race. Returns the skip reason ONLY for the two TOCTOU
// conditions the tombstone authority guards (row gone / no longer dormant / became
// explicitly protected); returns null for any state where the row was still a
// valid tombstone target (i.e. the VALIDATION came from a genuine shape
// precondition, not a race), so the caller rethrows loud.
async function classifyTombstoneRefusal(
  memoryLookup: ForgetDispositionMemoryLookupPort,
  objectId: string
): Promise<string | null> {
  const current = await memoryLookup.findById(objectId);
  if (current === null) {
    return "no longer present (concurrent removal)";
  }
  if (current.lifecycle_state !== "dormant") {
    return "no longer dormant (concurrent revival)";
  }
  if (isMemoryExplicitlyProtected(current)) {
    return "became explicitly protected (pinned/hazard/canon/consolidated)";
  }
  return null;
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
