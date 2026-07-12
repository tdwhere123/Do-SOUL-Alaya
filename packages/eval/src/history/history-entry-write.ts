import {
  access, copyFile, link, mkdir, mkdtemp, rename, rm, writeFile
} from "node:fs/promises";
import path from "node:path";
import type { BenchName, KpiPayload } from "../schema/kpi-schema.js";
import {
  FINDINGS_FILENAME,
  KPI_FILENAME,
  LATEST_PASSING_FILENAME,
  LATEST_RUN_FILENAME,
  REPORT_FILENAME,
  latestProviderPointerFilename,
  validateSidecarFilename,
  writeLegacyBaselinePointer,
  writePointer
} from "./history-files.js";
import type { HistoryEntry, HistoryLayout } from "./history.js";

export interface HistorySidecar {
  readonly filename: string;
  readonly contents: string;
}

export interface HistoryFileSidecar {
  readonly filename: string;
  readonly sourcePath: string;
}

export interface WriteEntryOptions {
  readonly sidecars?: readonly HistorySidecar[];
  readonly fileSidecars?: readonly HistoryFileSidecar[];
  readonly pointerWriter?: typeof writePointer;
}

export class HistoryEntryCommittedError extends Error {
  readonly committed = true;
  readonly entry: HistoryEntry;

  constructor(entry: HistoryEntry, cause: unknown) {
    super("history entry committed but pointer reconciliation failed", { cause });
    this.name = "HistoryEntryCommittedError";
    this.entry = entry;
  }
}

export function isHistoryEntryCommittedError(
  error: unknown
): error is HistoryEntryCommittedError {
  return error instanceof HistoryEntryCommittedError;
}

export const HISTORY_STAGING_PREFIX = ".tmp-";

export async function writeHistoryEntry(input: {
  readonly layout: HistoryLayout;
  readonly benchName: BenchName;
  readonly slug: string;
  readonly payload: KpiPayload;
  readonly report: string;
  readonly findings: string | null;
  readonly options: WriteEntryOptions;
  readonly entryAllowsPassing: () => Promise<boolean>;
}): Promise<HistoryEntry> {
  assertEntrySlug(input.slug);
  const benchRoot = path.join(input.layout.historyRoot, input.benchName);
  const sidecars = input.options.sidecars ?? [];
  const fileSidecars = input.options.fileSidecars ?? [];
  validateSidecars(sidecars, fileSidecars);
  const entryRoot = path.join(benchRoot, input.slug);
  await mkdir(benchRoot, { recursive: true });
  await assertEntryAbsent(entryRoot, input.slug);
  await stageAndCommitEntry(entryRoot, input, sidecars, fileSidecars);
  const entry = buildEntry(entryRoot, input.slug, sidecars, fileSidecars);
  try {
    await reconcileHistoryPointers({ ...input, entry });
  } catch (error) {
    throw new HistoryEntryCommittedError(entry, error);
  }
  return entry;
}

async function stageAndCommitEntry(
  entryRoot: string,
  input: Parameters<typeof writeHistoryEntry>[0],
  sidecars: readonly HistorySidecar[],
  fileSidecars: readonly HistoryFileSidecar[]
): Promise<void> {
  const benchRoot = path.dirname(entryRoot);
  const staging = await mkdtemp(path.join(benchRoot, `${HISTORY_STAGING_PREFIX}${input.slug}-`));
  try {
    await stageEntryFiles(staging, input.payload, input.report, input.findings, sidecars, fileSidecars);
    await rename(staging, entryRoot);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function reconcileHistoryPointers(input: {
  readonly layout: HistoryLayout;
  readonly benchName: BenchName;
  readonly entry: HistoryEntry;
  readonly payload: KpiPayload;
  readonly findings: string | null;
  readonly entryAllowsPassing: () => Promise<boolean>;
  readonly options?: WriteEntryOptions;
}): Promise<void> {
  const root = path.join(input.layout.historyRoot, input.benchName);
  const writer = input.options?.pointerWriter ?? writePointer;
  await writer(root, LATEST_RUN_FILENAME, input.entry.slug, input.entry.kpiPath);
  await writer(root, latestProviderPointerFilename("run", input.payload.embedding_provider),
    input.entry.slug, input.entry.kpiPath);
  if (input.findings !== null || !(await input.entryAllowsPassing())) return;
  await writer(root, LATEST_PASSING_FILENAME, input.entry.slug, input.entry.kpiPath);
  await writer(root, latestProviderPointerFilename("passing", input.payload.embedding_provider),
    input.entry.slug, input.entry.kpiPath);
  await writeLegacyBaselinePointer(
    root, input.payload.embedding_provider, input.entry.slug, input.entry.kpiPath
  );
}

function validateSidecars(
  sidecars: readonly HistorySidecar[],
  files: readonly HistoryFileSidecar[]
): void {
  for (const sidecar of [...sidecars, ...files]) validateSidecarFilename(sidecar.filename);
}

function assertEntrySlug(slug: string): void {
  if (slug.includes("/") || slug.includes("\\") || slug.includes("..") || slug.length === 0) {
    throw new Error(`invalid slug: '${slug}' contains a path separator or '..' token`);
  }
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error(
      `invalid slug: '${slug}' must match <YYYY-MM-DDTHHMMSSZ>-<sha7+> (use entrySlug helper)`
    );
  }
}

async function assertEntryAbsent(entryRoot: string, slug: string): Promise<void> {
  try {
    await access(entryRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`entry slug '${slug}' already exists at ${entryRoot}; refusing to overwrite (audit trail)`);
}

async function stageEntryFiles(
  root: string,
  payload: KpiPayload,
  report: string,
  findings: string | null,
  sidecars: readonly HistorySidecar[],
  fileSidecars: readonly HistoryFileSidecar[]
): Promise<void> {
  await writeFile(path.join(root, KPI_FILENAME), JSON.stringify(payload, null, 2) + "\n", "utf8");
  await writeFile(path.join(root, REPORT_FILENAME), report, "utf8");
  if (findings !== null) await writeFile(path.join(root, FINDINGS_FILENAME), findings, "utf8");
  for (const sidecar of sidecars) {
    await writeFile(path.join(root, sidecar.filename), sidecar.contents, "utf8");
  }
  for (const sidecar of fileSidecars) {
    await linkOrCopy(sidecar.sourcePath, path.join(root, sidecar.filename));
  }
}

function buildEntry(
  root: string,
  slug: string,
  sidecars: readonly HistorySidecar[],
  files: readonly HistoryFileSidecar[]
): HistoryEntry {
  return {
    slug,
    kpiPath: path.join(root, KPI_FILENAME),
    reportPath: path.join(root, REPORT_FILENAME),
    findingsPath: path.join(root, FINDINGS_FILENAME),
    sidecarPaths: Object.fromEntries(
      [...sidecars, ...files].map((item) => [item.filename, path.join(root, item.filename)])
    )
  };
}

async function linkOrCopy(source: string, destination: string): Promise<void> {
  try {
    await link(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await copyFile(source, destination);
  }
}

const SLUG_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{6}Z-[0-9a-f]{7,40}(?:-[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)?$/;
