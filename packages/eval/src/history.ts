import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { KpiPayloadSchema, type BenchName, type KpiPayload } from "./kpi-schema.js";

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
  const date = runAt.toISOString().slice(0, 10);
  return `${date}-${commitSha7}`;
}

export async function writeEntry(
  layout: HistoryLayout,
  benchName: BenchName,
  slug: string,
  payload: KpiPayload,
  reportMarkdown: string,
  findingsMarkdown: string | null
): Promise<HistoryEntry> {
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

export async function readLatest(
  layout: HistoryLayout,
  benchName: BenchName
): Promise<KpiPayload | null> {
  const slugs = await listEntries(layout, benchName);
  if (slugs.length === 0) return null;
  const newest = slugs[slugs.length - 1];
  if (newest === undefined) return null;
  return await readEntry(layout, benchName, newest);
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
