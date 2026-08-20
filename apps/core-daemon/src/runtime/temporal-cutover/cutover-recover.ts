import path from "node:path";
import {
  initDatabase,
  inspectTemporalProjectionSelection
} from "@do-soul/alaya-storage";
import {
  readTemporalCutoverJournal,
  type TemporalCutoverJournal
} from "./journal.js";
import {
  withTemporalCutoverLease,
  type TemporalCutoverLease
} from "./lease.js";
import {
  advanceJournal,
  assertJournalLockIdentity,
  assertPointerState,
  clearSelectedProjection,
  compensateIncompleteCutover,
  readPointerState,
  restoreOriginalPointer,
  verifyOrdinaryRuntimeBootstrap
} from "./cutover-apply.js";

export interface TemporalProjectionRollbackInput {
  readonly journalFilename: string;
  readonly reason: string;
  readonly now?: () => string;
}

export type TemporalProjectionRecoveryResult =
  | Readonly<{ readonly status: "committed"; readonly journalFilename: string }>
  | Readonly<{ readonly status: "compensated"; readonly journalFilename: string }>
  | Readonly<{ readonly status: "rolled_back"; readonly journalFilename: string }>;

export interface TemporalProjectionRollbackResult {
  readonly status: "rolled_back";
  readonly journalFilename: string;
  readonly originalPointer: string;
  /** The retained original can be legacy and is intentionally not restarted here. */
  readonly originalRuntimeState: "not_verified_may_fail_closed";
}

/** Restores the pointer first; retained legacy storage is deliberately not bootstrapped. */
export async function rollbackTemporalProjectionCutover(
  input: TemporalProjectionRollbackInput
): Promise<TemporalProjectionRollbackResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const initial = await readTemporalCutoverJournal(input.journalFilename);
  return await withTemporalCutoverLease(
    {
      configFilename: initial.configFilename,
      candidateFilename: initial.candidatePointer,
      runtimeFilenames: [initial.sourceFilename, initial.candidatePointer]
    },
    async (lease) => {
      let journal = await readTemporalCutoverJournal(input.journalFilename);
      assertJournalLockIdentity(initial, journal);
      assertRollbackEligible(journal);
      const pointerState = await readPointerState(journal);
      if (journal.status === "committed") {
        assertCommittedSelectionMatches(journal);
        if (pointerState === "candidate") await restoreOriginalPointer(journal);
        journal = await advanceJournal(lease, journal, input.journalFilename, "rollback_pointer_restored", now);
      } else {
        assertPointerState(pointerState, "original");
      }
      await clearSelectedProjection(journal, input.reason, now(), true);
      journal = await advanceJournal(lease, journal, input.journalFilename, "rolled_back", now);
      return Object.freeze({
        status: "rolled_back" as const,
        journalFilename: path.resolve(input.journalFilename),
        originalPointer: journal.originalPointer,
        originalRuntimeState: "not_verified_may_fail_closed" as const
      });
    }
  );
}

/** Resolves an interrupted journal from verified pointer and selection state, never a status guess. */
export async function recoverTemporalProjectionCutover(input: {
  readonly journalFilename: string;
  readonly reason: string;
  readonly now?: () => string;
}): Promise<TemporalProjectionRecoveryResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const initial = await readTemporalCutoverJournal(input.journalFilename);
  return await withTemporalCutoverLease(
    {
      configFilename: initial.configFilename,
      candidateFilename: initial.candidatePointer,
      runtimeFilenames: [initial.sourceFilename, initial.candidatePointer]
    },
    async (lease) => await recoverWithinLease(lease, input.journalFilename, input.reason, now, initial)
  );
}

async function recoverWithinLease(
  lease: TemporalCutoverLease,
  journalFilename: string,
  reason: string,
  now: () => string,
  initial: TemporalCutoverJournal
): Promise<TemporalProjectionRecoveryResult> {
  let journal = await readTemporalCutoverJournal(journalFilename);
  assertJournalLockIdentity(initial, journal);
  const resolvedJournalFilename = path.resolve(journalFilename);
  if (journal.status === "committed") {
    const pointerState = await readPointerState(journal);
    if (pointerState === "candidate") {
      assertCommittedSelectionMatches(journal);
      verifyOrdinaryRuntimeBootstrap(journal);
      return Object.freeze({ status: "committed", journalFilename: resolvedJournalFilename });
    }
    assertCommittedSelectionMatches(journal);
    journal = await advanceJournal(lease, journal, journalFilename, "rollback_pointer_restored", now);
    await clearSelectedProjection(journal, reason, now(), false);
    await advanceJournal(lease, journal, journalFilename, "rolled_back", now);
    return Object.freeze({ status: "rolled_back", journalFilename: resolvedJournalFilename });
  }
  if (journal.status === "compensated" || journal.status === "rolled_back") {
    assertPointerState(await readPointerState(journal), "original");
    assertCandidateUnselected(journal);
    return Object.freeze({ status: journal.status, journalFilename: resolvedJournalFilename });
  }
  if (journal.status === "rollback_pointer_restored") {
    assertPointerState(await readPointerState(journal), "original");
    await clearSelectedProjection(journal, reason, now(), true);
    await advanceJournal(lease, journal, journalFilename, "rolled_back", now);
    return Object.freeze({ status: "rolled_back", journalFilename: resolvedJournalFilename });
  }

  await compensateIncompleteCutover(lease, journal, journalFilename, now, reason);
  return Object.freeze({ status: "compensated", journalFilename: resolvedJournalFilename });
}

function assertRollbackEligible(journal: TemporalCutoverJournal): void {
  if (journal.status !== "committed" && journal.status !== "rollback_pointer_restored") {
    throw new Error(`Temporal cutover journal is not eligible for rollback: ${journal.status}`);
  }
}

function assertCommittedSelectionMatches(journal: TemporalCutoverJournal): void {
  const database = initDatabase({ filename: journal.candidatePointer, temporalMode: "candidate" });
  try {
    const state = inspectTemporalProjectionSelection(database);
    if (!state.selected || state.selectionId !== journal.selectionId) {
      throw new Error("Temporal candidate selection no longer matches the committed cutover journal.");
    }
  } finally {
    database.close();
  }
}

function assertCandidateUnselected(journal: TemporalCutoverJournal): void {
  const database = initDatabase({ filename: journal.candidatePointer, temporalMode: "candidate" });
  try {
    if (inspectTemporalProjectionSelection(database).selected) {
      throw new Error("Terminal temporal cutover journal still has a selected candidate.");
    }
  } finally {
    database.close();
  }
}
