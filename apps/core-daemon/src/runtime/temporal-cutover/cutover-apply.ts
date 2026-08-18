import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  initDatabase,
  inspectTemporalProjectionSelection,
  rollbackTemporalProjection,
  selectTemporalProjection
} from "@do-soul/alaya-storage";
import { writeTextAtomic } from "../config/storage-pointer-file.js";
import {
  advanceTemporalCutoverJournal,
  createTemporalCutoverJournal,
  type TemporalCutoverJournal,
  type TemporalCutoverJournalStatus
} from "./journal.js";
import {
  withTemporalCutoverLease,
  type TemporalCutoverLease
} from "./lease.js";
import {
  assertPreflightReceiptMatchesPlan,
  prepareCutoverPlan,
  readPreparedCandidateReceipt,
  readRequiredToml,
  requireText,
  type TemporalProjectionCutoverInput
} from "./cutover-plan.js";

export interface TemporalProjectionCutoverResult {
  readonly status: "committed";
  readonly journalFilename: string;
  readonly candidateFilename: string;
  readonly selectionId: string;
}

export type PointerState = "original" | "candidate";

/**
 * Selects a verified offline candidate only after moving the daemon pointer.
 * The config/candidate lease covers every journal and pointer transition.
 */
export async function cutOverTemporalProjection(
  input: TemporalProjectionCutoverInput
): Promise<TemporalProjectionCutoverResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const preflightReceipt = await readPreparedCandidateReceipt(
    path.resolve(requireText(input.candidateReceiptFilename, "candidate receipt filename"))
  );
  return await withTemporalCutoverLease(
    {
      configFilename: input.configPaths.tomlPath,
      candidateFilename: input.candidateFilename,
      runtimeFilenames: [preflightReceipt.sourceFilename, input.candidateFilename]
    },
    async (lease) => {
      const plan = await prepareCutoverPlan(input);
      assertPreflightReceiptMatchesPlan(preflightReceipt, plan);
      let journal = await createTemporalCutoverJournal(lease, plan.journalFilename, {
        configFilename: plan.configFilename,
        originalToml: plan.originalToml,
        candidateToml: plan.candidateToml,
        originalPointer: plan.originalPointer,
        candidatePointer: plan.candidatePointer,
        candidateReceiptFilename: plan.candidateReceiptFilename,
        sourceFilename: plan.sourceFilename,
        selectionId: randomUUID(),
        createdAt: now()
      });

      try {
        await switchPointerToCandidate(journal);
        journal = await advanceJournal(lease, journal, plan.journalFilename, "pointer_switched", now);
        selectCandidateProjection(journal, plan.reason, now());
        journal = await advanceJournal(lease, journal, plan.journalFilename, "selected", now);
        verifyOrdinaryRuntimeBootstrap(journal);
        journal = await advanceJournal(lease, journal, plan.journalFilename, "committed", now);
        return Object.freeze({
          status: "committed" as const,
          journalFilename: plan.journalFilename,
          candidateFilename: journal.candidatePointer,
          selectionId: journal.selectionId
        });
      } catch (error) {
        await compensateOrThrow(lease, journal, plan.journalFilename, now, error);
        throw error;
      }
    }
  );
}

export async function switchPointerToCandidate(journal: TemporalCutoverJournal): Promise<void> {
  await replaceTomlCas(journal.configFilename, journal.originalToml, journal.candidateToml);
}

export async function restoreOriginalPointer(journal: TemporalCutoverJournal): Promise<void> {
  const pointerState = await readPointerState(journal);
  if (pointerState === "original") return;
  await replaceTomlCas(journal.configFilename, journal.candidateToml, journal.originalToml);
}

async function replaceTomlCas(filename: string, expected: string, replacement: string): Promise<void> {
  if (await readRequiredToml(filename) !== expected) {
    throw new Error("Temporal cutover config changed concurrently; pointer CAS did not match.");
  }
  await writeTextAtomic(filename, replacement, 0o600);
  if (await readRequiredToml(filename) !== replacement) {
    throw new Error("Temporal cutover pointer write could not be verified; recovery must stop fail closed.");
  }
}

export function selectCandidateProjection(
  journal: TemporalCutoverJournal,
  reason: string,
  selectedAt: string
): void {
  const database = initDatabase({ filename: journal.candidatePointer, temporalMode: "candidate" });
  try {
    const selected = selectTemporalProjection(database, {
      receiptFilename: journal.candidateReceiptFilename,
      reason,
      selectedAt,
      selectionId: journal.selectionId
    });
    if (!selected.selected || selected.selectionId !== journal.selectionId) {
      throw new Error("Temporal candidate selection did not persist its precommitted selection id.");
    }
  } finally {
    database.close();
  }
}

export function verifyOrdinaryRuntimeBootstrap(journal: TemporalCutoverJournal): void {
  const database = initDatabase({ filename: journal.candidatePointer });
  try {
    const selection = inspectTemporalProjectionSelection(database);
    if (!selection.selected || selection.selectionId !== journal.selectionId) {
      throw new Error("Temporal candidate ordinary runtime bootstrap does not match the cutover selection.");
    }
  } finally {
    database.close();
  }
}

export async function compensateOrThrow(
  lease: TemporalCutoverLease,
  journal: TemporalCutoverJournal,
  journalFilename: string,
  now: () => string,
  error: unknown
): Promise<void> {
  try {
    await compensateIncompleteCutover(lease, journal, journalFilename, now, errorMessage(error));
  } catch (compensationError) {
    throw new Error(
      `Temporal cutover failed and automatic compensation also failed: ${errorMessage(compensationError)}`
    );
  }
}

export async function compensateIncompleteCutover(
  lease: TemporalCutoverLease,
  journal: TemporalCutoverJournal,
  journalFilename: string,
  now: () => string,
  reason: string
): Promise<void> {
  await restoreOriginalPointer(journal);
  await clearSelectedProjection(journal, `cutover compensation: ${reason}`, now(), true);
  await advanceJournal(lease, journal, journalFilename, "compensated", now);
}

export async function clearSelectedProjection(
  journal: TemporalCutoverJournal,
  reason: string,
  rolledBackAt: string,
  allowUnselected: boolean
): Promise<void> {
  const database = initDatabase({ filename: journal.candidatePointer, temporalMode: "candidate" });
  try {
    const state = inspectTemporalProjectionSelection(database);
    if (!state.selected) {
      if (allowUnselected) return;
      throw new Error("Temporal candidate selection is absent for this cutover journal.");
    }
    if (state.selectionId !== journal.selectionId) {
      throw new Error("Temporal candidate selection belongs to a different cutover journal.");
    }
    rollbackTemporalProjection(database, {
      receiptFilename: journal.candidateReceiptFilename,
      expectedSelectionId: journal.selectionId,
      reason: requireText(reason, "rollback reason"),
      rolledBackAt
    });
  } finally {
    database.close();
  }
}

export function assertJournalLockIdentity(
  expected: TemporalCutoverJournal,
  actual: TemporalCutoverJournal
): void {
  if (
    expected.configFilename !== actual.configFilename ||
    expected.candidatePointer !== actual.candidatePointer ||
    expected.sourceFilename !== actual.sourceFilename
  ) {
    throw new Error("Temporal cutover journal changed its locked resource identity.");
  }
}

export async function readPointerState(journal: TemporalCutoverJournal): Promise<PointerState> {
  const current = await readRequiredToml(journal.configFilename);
  if (current === journal.originalToml) return "original";
  if (current === journal.candidateToml) return "candidate";
  throw new Error("Temporal cutover config changed outside the journal; recovery must stop fail closed.");
}

export function assertPointerState(actual: PointerState, expected: PointerState): void {
  if (actual !== expected) {
    throw new Error(`Temporal cutover expected ${expected} pointer before this transition.`);
  }
}

export async function advanceJournal(
  lease: TemporalCutoverLease,
  journal: TemporalCutoverJournal,
  filename: string,
  status: TemporalCutoverJournalStatus,
  now: () => string
): Promise<TemporalCutoverJournal> {
  return await advanceTemporalCutoverJournal({
    lease,
    filename,
    expected: journal,
    status,
    updatedAt: now()
  });
}

export function errorMessage(error: unknown): string {
  return requireText(error instanceof Error ? error.message : String(error), "cutover error");
}
