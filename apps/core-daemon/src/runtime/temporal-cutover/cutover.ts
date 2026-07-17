import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  initDatabase,
  inspectTemporalProjectionSelection,
  rollbackTemporalProjection,
  selectTemporalProjection
} from "@do-soul/alaya-storage";
import type { AlayaConfigPaths } from "../../cli/config-files.js";
import {
  replaceStorageDbPathInToml,
  writeTextAtomic
} from "../config/storage-pointer-file.js";
import { parseStorageDbPathFromToml } from "../storage-config.js";
import {
  advanceTemporalCutoverJournal,
  createTemporalCutoverJournal,
  readTemporalCutoverJournal,
  type TemporalCutoverJournal,
  type TemporalCutoverJournalStatus
} from "./journal.js";
import {
  withTemporalCutoverLease,
  type TemporalCutoverLease
} from "./lease.js";

export interface TemporalProjectionCutoverInput {
  readonly configPaths: Pick<AlayaConfigPaths, "tomlPath">;
  readonly candidateFilename: string;
  readonly candidateReceiptFilename: string;
  readonly reason: string;
  readonly journalFilename?: string;
  readonly now?: () => string;
}

export interface TemporalProjectionRollbackInput {
  readonly journalFilename: string;
  readonly reason: string;
  readonly now?: () => string;
}

export type TemporalProjectionRecoveryResult =
  | Readonly<{ readonly status: "committed"; readonly journalFilename: string }>
  | Readonly<{ readonly status: "compensated"; readonly journalFilename: string }>
  | Readonly<{ readonly status: "rolled_back"; readonly journalFilename: string }>;

export interface TemporalProjectionCutoverResult {
  readonly status: "committed";
  readonly journalFilename: string;
  readonly candidateFilename: string;
  readonly selectionId: string;
}

export interface TemporalProjectionRollbackResult {
  readonly status: "rolled_back";
  readonly journalFilename: string;
  readonly originalPointer: string;
  /** The retained original can be legacy and is intentionally not restarted here. */
  readonly originalRuntimeState: "not_verified_may_fail_closed";
}

interface CutoverPlan {
  readonly journalFilename: string;
  readonly configFilename: string;
  readonly originalToml: string;
  readonly candidateToml: string;
  readonly originalPointer: string;
  readonly candidatePointer: string;
  readonly candidateReceiptFilename: string;
  readonly sourceFilename: string;
  readonly reason: string;
}

interface CandidateReceiptPaths {
  readonly sourceFilename: string;
  readonly candidateFilename: string;
}

type PointerState = "original" | "candidate";

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

async function prepareCutoverPlan(input: TemporalProjectionCutoverInput): Promise<CutoverPlan> {
  const configFilename = path.resolve(input.configPaths.tomlPath);
  const originalToml = await readRequiredToml(configFilename);
  const originalPointer = readExplicitPointer(originalToml, configFilename);
  const candidatePointer = path.resolve(requireText(input.candidateFilename, "candidate filename"));
  const candidateReceiptFilename = path.resolve(
    requireText(input.candidateReceiptFilename, "candidate receipt filename")
  );
  const receipt = await readPreparedCandidateReceipt(candidateReceiptFilename);
  assertReceiptMatchesPlan(receipt, originalPointer, candidatePointer);
  return Object.freeze({
    journalFilename: path.resolve(input.journalFilename ?? `${configFilename}.temporal-cutover.json`),
    configFilename,
    originalToml,
    candidateToml: replaceStorageDbPathInToml(originalToml, candidatePointer),
    originalPointer,
    candidatePointer,
    candidateReceiptFilename,
    sourceFilename: receipt.sourceFilename,
    reason: requireText(input.reason, "cutover reason")
  });
}

async function readRequiredToml(filename: string): Promise<string> {
  try {
    return await readFile(filename, "utf8");
  } catch (error) {
    throw new Error(`Temporal cutover requires an existing explicit config pointer: ${filename}`, {
      cause: error
    });
  }
}

function readExplicitPointer(toml: string, filename: string): string {
  const configured = parseStorageDbPathFromToml(toml);
  if (configured === null) {
    throw new Error(
      `Temporal cutover requires [storage].db_path in ${filename}; an env or fallback path cannot be exactly compensated.`
    );
  }
  return path.resolve(configured);
}

async function readPreparedCandidateReceipt(filename: string): Promise<CandidateReceiptPaths> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    throw new Error(`Temporal candidate receipt is unavailable: ${filename}`, { cause: error });
  }
  if (!isRecord(parsed) || parsed.receipt_version !== 1 || parsed.kind !== "temporal_offline_candidate" ||
      parsed.status !== "prepared" || parsed.selected !== false) {
    throw new Error("Temporal candidate receipt is not an unselected prepared candidate.");
  }
  const source = requireRecord(parsed.source, "candidate receipt source");
  const candidate = requireRecord(parsed.candidate, "candidate receipt candidate");
  return Object.freeze({
    sourceFilename: path.resolve(requireText(source.filename, "candidate source filename")),
    candidateFilename: path.resolve(requireText(candidate.filename, "candidate filename"))
  });
}
function assertReceiptMatchesPlan(
  receipt: CandidateReceiptPaths,
  originalPointer: string,
  candidatePointer: string
): void {
  if (receipt.sourceFilename !== originalPointer || receipt.candidateFilename !== candidatePointer) {
    throw new Error("Temporal candidate receipt does not bind the configured original pointer to this candidate.");
  }
  if (originalPointer === candidatePointer) {
    throw new Error("Temporal cutover candidate must differ from the configured original pointer.");
  }
}
function assertPreflightReceiptMatchesPlan(receipt: CandidateReceiptPaths, plan: CutoverPlan): void {
  if (receipt.sourceFilename !== plan.sourceFilename || receipt.candidateFilename !== plan.candidatePointer) {
    throw new Error("Temporal candidate receipt changed before its source could be frozen.");
  }
}
function assertJournalLockIdentity(
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
async function switchPointerToCandidate(journal: TemporalCutoverJournal): Promise<void> {
  await replaceTomlCas(journal.configFilename, journal.originalToml, journal.candidateToml);
}

async function restoreOriginalPointer(journal: TemporalCutoverJournal): Promise<void> {
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

function selectCandidateProjection(journal: TemporalCutoverJournal, reason: string, selectedAt: string): void {
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

function verifyOrdinaryRuntimeBootstrap(journal: TemporalCutoverJournal): void {
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

async function compensateOrThrow(
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

async function compensateIncompleteCutover(
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

async function clearSelectedProjection(
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

async function readPointerState(journal: TemporalCutoverJournal): Promise<PointerState> {
  const current = await readRequiredToml(journal.configFilename);
  if (current === journal.originalToml) return "original";
  if (current === journal.candidateToml) return "candidate";
  throw new Error("Temporal cutover config changed outside the journal; recovery must stop fail closed.");
}

function assertPointerState(actual: PointerState, expected: PointerState): void {
  if (actual !== expected) {
    throw new Error(`Temporal cutover expected ${expected} pointer before this transition.`);
  }
}

async function advanceJournal(
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

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > 900) {
    throw new Error(`Invalid ${label}.`);
  }
  return value.trim();
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Invalid ${label}.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return requireText(error instanceof Error ? error.message : String(error), "cutover error");
}
