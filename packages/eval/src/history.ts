import { randomBytes } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import {
  KpiPayloadSchema,
  type BenchName,
  type BenchPolicyShape,
  type BenchSimulateReportMode,
  type BenchSplit,
  type KpiPayload
} from "./kpi-schema.js";

export interface HistoryLayout {
  readonly historyRoot: string;
}

export interface HistoryEntry {
  readonly slug: string;
  readonly kpiPath: string;
  readonly reportPath: string;
  readonly findingsPath: string;
  readonly sidecarPaths: Readonly<Record<string, string>>;
}

export interface HistorySidecar {
  readonly filename: string;
  readonly contents: string;
}

export interface WriteEntryOptions {
  readonly sidecars?: readonly HistorySidecar[];
}

const KPI_FILENAME = "kpi.json";
const REPORT_FILENAME = "report.md";
const FINDINGS_FILENAME = "findings.md";
const LATEST_BASELINE_FILENAME = "latest-baseline.json";

export function entrySlug(
  runAt: Date,
  commitSha7: string,
  discriminator?: string
): string {
  const iso = runAt.toISOString();
  const stamp = `${iso.slice(0, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  if (discriminator === undefined) {
    return `${stamp}-${commitSha7}`;
  }
  if (!SLUG_DISCRIMINATOR_PATTERN.test(discriminator)) {
    throw new Error(
      `invalid slug discriminator: '${discriminator}' must use lowercase letters, digits, and hyphens`
    );
  }
  return `${stamp}-${commitSha7}-${discriminator}`;
}

export function policyShapeSlug(policyShape: BenchPolicyShape): string {
  return `policy-${policyShape}`;
}

export function simulateReportSlug(
  simulateReport: BenchSimulateReportMode
): string {
  return `report-${simulateReport}`;
}

export function benchArchiveDiscriminator(
  policyShape: BenchPolicyShape,
  simulateReport: BenchSimulateReportMode
): string {
  const policySlug = policyShapeSlug(policyShape);
  if (simulateReport === "none") return policySlug;
  return `${policySlug}-${simulateReportSlug(simulateReport)}`;
}

const SLUG_DISCRIMINATOR_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SLUG_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{6}Z-[0-9a-f]{7,40}(?:-[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)?$/;

/**
 * @anchor write-entry-atomic — stage in a sibling .tmp- directory
 * (created via mkdtemp so two concurrent writers on the same slug
 * cannot collide), then rename(2) into place. Either the entry exists
 * in full (kpi.json + report.md + optional findings.md + required
 * sidecars) or the slug directory does not exist — never half-written.
 * The pointer is also written via tmp + rename. If the target slug already exists,
 * writeEntry throws rather than overwriting.
 * see also: @anchor write-entry-tmp-filter in listEntries — orphan
 * staging directories (process kill between mkdtemp and rename) are
 * filtered out of the slug listing.
 */
export async function writeEntry(
  layout: HistoryLayout,
  benchName: BenchName,
  slug: string,
  payload: KpiPayload,
  reportMarkdown: string,
  findingsMarkdown: string | null,
  options: WriteEntryOptions = {}
): Promise<HistoryEntry> {
  if (slug.includes("/") || slug.includes("\\") || slug.includes("..") || slug.length === 0) {
    throw new Error(`invalid slug: '${slug}' contains a path separator or '..' token`);
  }
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error(
      `invalid slug: '${slug}' must match <YYYY-MM-DDTHHMMSSZ>-<sha7+> (use entrySlug helper)`
    );
  }
  const benchRoot = path.join(layout.historyRoot, benchName);
  const sidecars = options.sidecars ?? [];
  for (const sidecar of sidecars) {
    validateSidecarFilename(sidecar.filename);
  }
  await mkdir(benchRoot, { recursive: true });
  const entryRoot = path.join(benchRoot, slug);
  try {
    await access(entryRoot);
    throw new Error(
      `entry slug '${slug}' already exists at ${entryRoot}; refusing to overwrite (audit trail)`
    );
  } catch (err) {
    if (
      err !== null &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: string }).code === "ENOENT"
    ) {
      // ENOENT means the slug is free; any other error is fatal.
    } else {
      throw err;
    }
  }
  const stagingRoot = await mkdtemp(path.join(benchRoot, `${STAGING_PREFIX}${slug}-`));
  try {
    const stagingKpi = path.join(stagingRoot, KPI_FILENAME);
    const stagingReport = path.join(stagingRoot, REPORT_FILENAME);
    const stagingFindings = path.join(stagingRoot, FINDINGS_FILENAME);
    await writeFile(stagingKpi, JSON.stringify(payload, null, 2) + "\n", "utf8");
    await writeFile(stagingReport, reportMarkdown, "utf8");
    if (findingsMarkdown !== null) {
      await writeFile(stagingFindings, findingsMarkdown, "utf8");
    }
    for (const sidecar of sidecars) {
      await writeFile(path.join(stagingRoot, sidecar.filename), sidecar.contents, "utf8");
    }
    await rename(stagingRoot, entryRoot);
  } catch (err) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw err;
  }

  const kpiPath = path.join(entryRoot, KPI_FILENAME);
  const reportPath = path.join(entryRoot, REPORT_FILENAME);
  const findingsPath = path.join(entryRoot, FINDINGS_FILENAME);
  const sidecarPaths = Object.fromEntries(
    sidecars.map((sidecar) => [sidecar.filename, path.join(entryRoot, sidecar.filename)])
  );

  const pointerPath = path.join(benchRoot, LATEST_BASELINE_FILENAME);
  // Pointer tmp suffix combines pid + 4-byte random (8 hex chars,
  // ~4.3e9 namespace) so two same-PID concurrent writeEntry calls
  // (worker_threads) cannot collide on the tmp filename even though
  // Node's main thread is single-runtime.
  const pointerTmp = `${pointerPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(
    pointerTmp,
    JSON.stringify({ slug, kpi_path: path.relative(benchRoot, kpiPath) }, null, 2) + "\n",
    "utf8"
  );
  await rename(pointerTmp, pointerPath);

  return { slug, kpiPath, reportPath, findingsPath, sidecarPaths };
}

// @anchor write-entry-tmp-filter: staging directories created by
// writeEntry must never surface as "slugs" to readers. Pattern matches
// `.tmp-<slug>-<mkdtemp-suffix>`. listEntries also skips any directory
// whose name does not match the canonical SLUG_PATTERN; that is a
// silent skip by design (a future archive may carry sidecar dirs like
// `evidence/` or `datasets/` at the bench root that are not slugs).
const STAGING_PREFIX = ".tmp-";

export async function listEntries(
  layout: HistoryLayout,
  benchName: BenchName
): Promise<readonly string[]> {
  const benchRoot = path.join(layout.historyRoot, benchName);
  try {
    const entries = await readdir(benchRoot);
    const slugs: string[] = [];
    for (const entry of entries) {
      if (entry === LATEST_BASELINE_FILENAME) continue;
      if (entry.startsWith(STAGING_PREFIX)) continue;
      if (!SLUG_PATTERN.test(entry)) continue;
      const fullPath = path.join(benchRoot, entry);
      const st = await stat(fullPath).catch(() => null);
      if (st !== null && st.isDirectory()) slugs.push(entry);
    }
    slugs.sort();
    return slugs;
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

export async function readEntry(
  layout: HistoryLayout,
  benchName: BenchName,
  slug: string
): Promise<KpiPayload | null> {
  const benchRoot = path.join(layout.historyRoot, benchName);
  const kpiPath = path.join(benchRoot, slug, KPI_FILENAME);
  try {
    const raw = await readFile(kpiPath, "utf8");
    return KpiPayloadSchema.parse(JSON.parse(raw));
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/**
 * @anchor read-latest-split-aware — diff must be apple-to-apple
 *
 * Without the `split` filter, the diff engine would compare Oracle (filter
 * no-op, ~100% R@K artifact) against LongMemEval-S (real retrieval, lower
 * R@K), trigger a spurious "5pp drop = ✗ FAIL", and pollute findings.md.
 * Callers that own a split-specific cadence (Oracle 500 vs S smoke) pass
 * `opts.split`; callers that just want the newest entry (e.g. Inspector
 * Overview "latest run" card) leave it undefined.
 *
 * When `opts.split` is provided we ignore `latest-baseline.json` (which
 * tracks only the absolute newest entry, not per-split) and scan via
 * listEntries → readEntry → filter.
 */
export async function readLatest(
  layout: HistoryLayout,
  benchName: BenchName,
  opts: {
    split?: BenchSplit;
    policyShape?: BenchPolicyShape;
    simulateReport?: BenchSimulateReportMode;
    embeddingProvider?: string;
  } = {}
): Promise<KpiPayload | null> {
  if (
    opts.split !== undefined ||
    opts.policyShape !== undefined ||
    opts.simulateReport !== undefined ||
    opts.embeddingProvider !== undefined
  ) {
    const slugs = await listEntries(layout, benchName);
    for (let i = slugs.length - 1; i >= 0; i--) {
      const slug = slugs[i];
      if (slug === undefined) continue;
      const entry = await readEntry(layout, benchName, slug);
      if (
        entry !== null &&
        (opts.split === undefined || entry.split === opts.split) &&
        (opts.policyShape === undefined ||
          (entry.policy_shape ?? "stress") === opts.policyShape) &&
        (opts.simulateReport === undefined ||
          (entry.simulate_report ?? "none") === opts.simulateReport) &&
        (opts.embeddingProvider === undefined ||
          entry.embedding_provider === opts.embeddingProvider)
      ) {
        return entry;
      }
    }
    return null;
  }

  const pointerSlug = await readLatestPointerSlug(layout, benchName);
  if (pointerSlug !== null) {
    const pointed = await readEntry(layout, benchName, pointerSlug);
    if (pointed !== null) return pointed;
  }
  const slugs = await listEntries(layout, benchName);
  if (slugs.length === 0) return null;
  const newest = slugs[slugs.length - 1];
  if (newest === undefined) return null;
  return await readEntry(layout, benchName, newest);
}

async function readLatestPointerSlug(
  layout: HistoryLayout,
  benchName: BenchName
): Promise<string | null> {
  const pointerPath = path.join(layout.historyRoot, benchName, LATEST_BASELINE_FILENAME);
  try {
    const raw = await readFile(pointerPath, "utf8");
    const parsed = JSON.parse(raw) as { slug?: unknown };
    if (typeof parsed.slug === "string" && parsed.slug.length > 0) {
      return parsed.slug;
    }
    return null;
  } catch (error) {
    if (isNotFound(error)) return null;
    return null;
  }
}

export async function readPrevious(
  layout: HistoryLayout,
  benchName: BenchName,
  currentSlug: string
): Promise<KpiPayload | null> {
  const slugs = await listEntries(layout, benchName);
  const currentIndex = slugs.indexOf(currentSlug);
  if (currentIndex <= 0) return null;
  const previousSlug = slugs[currentIndex - 1];
  if (previousSlug === undefined) return null;
  return await readEntry(layout, benchName, previousSlug);
}

function isNotFound(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code: string }).code === "ENOENT"
  );
}

function validateSidecarFilename(filename: string): void {
  const reserved = new Set([
    KPI_FILENAME,
    REPORT_FILENAME,
    FINDINGS_FILENAME,
    LATEST_BASELINE_FILENAME
  ]);
  if (
    filename.length === 0 ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename.includes("..") ||
    filename !== path.basename(filename) ||
    reserved.has(filename)
  ) {
    throw new Error(`invalid sidecar filename: '${filename}'`);
  }
}
