import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  KpiPayloadSchema,
  type BenchName,
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
}

const KPI_FILENAME = "kpi.json";
const REPORT_FILENAME = "report.md";
const FINDINGS_FILENAME = "findings.md";
const LATEST_BASELINE_FILENAME = "latest-baseline.json";

export function entrySlug(runAt: Date, commitSha7: string): string {
  const iso = runAt.toISOString();
  const stamp = `${iso.slice(0, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  return `${stamp}-${commitSha7}`;
}

const SLUG_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{6}Z-[0-9a-f]{7,40}$/;

export async function writeEntry(
  layout: HistoryLayout,
  benchName: BenchName,
  slug: string,
  payload: KpiPayload,
  reportMarkdown: string,
  findingsMarkdown: string | null
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
  const entryRoot = path.join(benchRoot, slug);
  await mkdir(entryRoot, { recursive: true });
  const kpiPath = path.join(entryRoot, KPI_FILENAME);
  const reportPath = path.join(entryRoot, REPORT_FILENAME);
  const findingsPath = path.join(entryRoot, FINDINGS_FILENAME);
  await writeFile(kpiPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  await writeFile(reportPath, reportMarkdown, "utf8");
  if (findingsMarkdown !== null) {
    await writeFile(findingsPath, findingsMarkdown, "utf8");
  }
  await writeFile(
    path.join(benchRoot, LATEST_BASELINE_FILENAME),
    JSON.stringify({ slug, kpi_path: path.relative(benchRoot, kpiPath) }, null, 2) + "\n",
    "utf8"
  );
  return { slug, kpiPath, reportPath, findingsPath };
}

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
  opts: { split?: BenchSplit } = {}
): Promise<KpiPayload | null> {
  if (opts.split !== undefined) {
    const slugs = await listEntries(layout, benchName);
    for (let i = slugs.length - 1; i >= 0; i--) {
      const slug = slugs[i];
      if (slug === undefined) continue;
      const entry = await readEntry(layout, benchName, slug);
      if (entry !== null && entry.split === opts.split) {
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
