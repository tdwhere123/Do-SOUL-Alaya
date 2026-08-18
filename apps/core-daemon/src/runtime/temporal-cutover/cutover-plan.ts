import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AlayaConfigPaths } from "../../cli/support/config-files.js";
import { replaceStorageDbPathInToml } from "../config/storage-pointer-file.js";
import { parseStorageDbPathFromToml } from "../daemon/support/storage-config.js";

export interface TemporalProjectionCutoverInput {
  readonly configPaths: Pick<AlayaConfigPaths, "tomlPath">;
  readonly candidateFilename: string;
  readonly candidateReceiptFilename: string;
  readonly reason: string;
  readonly journalFilename?: string;
  readonly now?: () => string;
}

export interface CutoverPlan {
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

export interface CandidateReceiptPaths {
  readonly sourceFilename: string;
  readonly candidateFilename: string;
}

export async function prepareCutoverPlan(input: TemporalProjectionCutoverInput): Promise<CutoverPlan> {
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

export async function readRequiredToml(filename: string): Promise<string> {
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

export async function readPreparedCandidateReceipt(filename: string): Promise<CandidateReceiptPaths> {
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

export function assertPreflightReceiptMatchesPlan(receipt: CandidateReceiptPaths, plan: CutoverPlan): void {
  if (receipt.sourceFilename !== plan.sourceFilename || receipt.candidateFilename !== plan.candidatePointer) {
    throw new Error("Temporal candidate receipt changed before its source could be frozen.");
  }
}

export function requireText(value: unknown, label: string): string {
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
