import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  writeNewTextAtomic,
  writeTextAtomic
} from "../config/storage-pointer-file.js";
import {
  assertTemporalCutoverLease,
  type TemporalCutoverLease
} from "./lease.js";

export type TemporalCutoverJournalStatus =
  | "prepared"
  | "pointer_switched"
  | "selected"
  | "committed"
  | "compensated"
  | "rollback_pointer_restored"
  | "rolled_back";

export interface TemporalCutoverJournal {
  readonly journalVersion: 2;
  readonly revision: number;
  readonly status: TemporalCutoverJournalStatus;
  readonly configFilename: string;
  readonly originalToml: string;
  readonly candidateToml: string;
  readonly originalPointer: string;
  readonly candidatePointer: string;
  readonly candidateReceiptFilename: string;
  readonly sourceFilename: string;
  /** Generated before selection and persisted in the selection state if it succeeds. */
  readonly selectionId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly error: string | null;
}

type JournalSeed = Omit<
  TemporalCutoverJournal,
  "journalVersion" | "revision" | "status" | "updatedAt" | "error"
>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const ALLOWED_TRANSITIONS: Readonly<Record<TemporalCutoverJournalStatus, readonly TemporalCutoverJournalStatus[]>> = {
  prepared: ["pointer_switched", "compensated"],
  pointer_switched: ["selected", "compensated"],
  selected: ["committed", "compensated"],
  committed: ["rollback_pointer_restored"],
  compensated: [],
  rollback_pointer_restored: ["rolled_back"],
  rolled_back: []
};

export async function createTemporalCutoverJournal(
  lease: TemporalCutoverLease,
  filename: string,
  input: JournalSeed
): Promise<TemporalCutoverJournal> {
  const normalizedFilename = path.resolve(filename);
  const journal = Object.freeze({
    journalVersion: 2 as const,
    revision: 0,
    status: "prepared" as const,
    ...normalizeSeed(input),
    updatedAt: input.createdAt,
    error: null
  });
  assertLeaseOwnsJournal(lease, journal);
  try {
    await writeNewTextAtomic(normalizedFilename, serializeJournal(journal), 0o600);
  } catch (error) {
    if (isNodeErrorWithCode(error, "EEXIST")) {
      throw new Error(`Temporal cutover journal already exists: ${normalizedFilename}`);
    }
    throw error;
  }
  return journal;
}

export async function readTemporalCutoverJournal(filename: string): Promise<TemporalCutoverJournal> {
  const normalizedFilename = path.resolve(filename);
  let raw: string;
  try {
    raw = await readFile(normalizedFilename, "utf8");
  } catch (error) {
    throw new Error(`Temporal cutover journal is unavailable: ${normalizedFilename}`, { cause: error });
  }
  return parseJournal(raw, normalizedFilename);
}

export async function advanceTemporalCutoverJournal(input: {
  readonly lease: TemporalCutoverLease;
  readonly filename: string;
  readonly expected: TemporalCutoverJournal;
  readonly status: TemporalCutoverJournalStatus;
  readonly updatedAt: string;
  readonly error?: string | null;
}): Promise<TemporalCutoverJournal> {
  const filename = path.resolve(input.filename);
  assertLeaseOwnsJournal(input.lease, input.expected);
  const current = await readTemporalCutoverJournal(filename);
  assertLeaseOwnsJournal(input.lease, current);
  if (!sameJournal(current, input.expected)) {
    throw new Error("Temporal cutover journal changed concurrently; recovery must stop fail closed.");
  }
  assertTransition(current.status, input.status);

  const next = Object.freeze({
    ...current,
    revision: current.revision + 1,
    status: input.status,
    updatedAt: readTimestamp(input.updatedAt, "updated at"),
    error: input.error ?? current.error
  });
  await writeTextAtomic(filename, serializeJournal(next), 0o600);
  return next;
}

function normalizeSeed(input: JournalSeed): JournalSeed {
  return Object.freeze({
    configFilename: readPath(input.configFilename, "config filename"),
    originalToml: readText(input.originalToml, "original TOML"),
    candidateToml: readText(input.candidateToml, "candidate TOML"),
    originalPointer: readPath(input.originalPointer, "original pointer"),
    candidatePointer: readPath(input.candidatePointer, "candidate pointer"),
    candidateReceiptFilename: readPath(input.candidateReceiptFilename, "candidate receipt filename"),
    sourceFilename: readPath(input.sourceFilename, "source filename"),
    selectionId: readUuid(input.selectionId, "selection id"),
    createdAt: readTimestamp(input.createdAt, "created at")
  });
}

function assertLeaseOwnsJournal(lease: TemporalCutoverLease, journal: TemporalCutoverJournal): void {
  assertTemporalCutoverLease(lease, {
    configFilename: journal.configFilename,
    candidateFilename: journal.candidatePointer
  });
}

function assertTransition(
  from: TemporalCutoverJournalStatus,
  to: TemporalCutoverJournalStatus
): void {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new Error(`Temporal cutover journal cannot transition from ${from} to ${to}.`);
  }
}

function sameJournal(left: TemporalCutoverJournal, right: TemporalCutoverJournal): boolean {
  return left.journalVersion === right.journalVersion &&
    left.revision === right.revision &&
    left.status === right.status &&
    left.configFilename === right.configFilename &&
    left.originalToml === right.originalToml &&
    left.candidateToml === right.candidateToml &&
    left.originalPointer === right.originalPointer &&
    left.candidatePointer === right.candidatePointer &&
    left.candidateReceiptFilename === right.candidateReceiptFilename &&
    left.sourceFilename === right.sourceFilename &&
    left.selectionId === right.selectionId &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.error === right.error;
}

function serializeJournal(journal: TemporalCutoverJournal): string {
  return `${JSON.stringify(journal, null, 2)}\n`;
}

function parseJournal(raw: string, filename: string): TemporalCutoverJournal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Temporal cutover journal is malformed: ${filename}`, { cause: error });
  }
  if (!isRecord(parsed) || parsed.journalVersion !== 2) {
    throw new Error(`Temporal cutover journal has an unsupported shape: ${filename}`);
  }
  return Object.freeze({
    journalVersion: 2,
    revision: readNonNegativeInteger(parsed.revision, "revision"),
    status: readStatus(parsed.status),
    configFilename: readPath(parsed.configFilename, "config filename"),
    originalToml: readText(parsed.originalToml, "original TOML"),
    candidateToml: readText(parsed.candidateToml, "candidate TOML"),
    originalPointer: readPath(parsed.originalPointer, "original pointer"),
    candidatePointer: readPath(parsed.candidatePointer, "candidate pointer"),
    candidateReceiptFilename: readPath(parsed.candidateReceiptFilename, "candidate receipt filename"),
    sourceFilename: readPath(parsed.sourceFilename, "source filename"),
    selectionId: readUuid(parsed.selectionId, "selection id"),
    createdAt: readTimestamp(parsed.createdAt, "created at"),
    updatedAt: readTimestamp(parsed.updatedAt, "updated at"),
    error: readNullableText(parsed.error, "error")
  });
}

function readStatus(value: unknown): TemporalCutoverJournalStatus {
  if (typeof value !== "string" || !(value in ALLOWED_TRANSITIONS)) {
    throw new Error("Temporal cutover journal has an invalid status.");
  }
  return value as TemporalCutoverJournalStatus;
}

function readPath(value: unknown, label: string): string {
  return path.resolve(readText(value, label));
}

function readUuid(value: unknown, label: string): string {
  const uuid = readText(value, label);
  if (!UUID_PATTERN.test(uuid)) {
    throw new Error(`Temporal cutover journal has an invalid ${label}.`);
  }
  return uuid.toLowerCase();
}

function readText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_000_000) {
    throw new Error(`Temporal cutover journal has an invalid ${label}.`);
  }
  return value;
}

function readNullableText(value: unknown, label: string): string | null {
  if (value === null) return null;
  return readText(value, label);
}

function readNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Temporal cutover journal has an invalid ${label}.`);
  }
  return value;
}

function readTimestamp(value: unknown, label: string): string {
  const text = readText(value, label);
  if (Number.isNaN(Date.parse(text))) {
    throw new Error(`Temporal cutover journal has an invalid ${label}.`);
  }
  return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
