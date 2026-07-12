import {
  access,
  readFile,
  readdir,
  stat
} from "node:fs/promises";
import path from "node:path";
import { ZodError } from "zod";
import {
  KpiPayloadSchema,
  type BenchName,
  type BenchPolicyShape,
  type BenchSimulateReportMode,
  type BenchSplit,
  type KpiPayload
} from "../schema/kpi-schema.js";
import { releaseHardGateAllowsLatestPassing } from "../gates/release-gates.js";
import { evaluateSeedExtractionReleaseBlocker } from "../gates/seed-extraction-blocker.js";
import {
  FINDINGS_FILENAME,
  KPI_FILENAME,
  LATEST_BASELINE_FILENAME,
  LATEST_PASSING_FILENAME,
  LATEST_RUN_FILENAME,
  LIVE_GATES_FILENAME,
  REPORT_FILENAME,
  latestPointerFilename,
  latestProviderPointerFilename,
  type HistoryPointerKind
} from "./history-files.js";
import { liveGatesSidecarAllowsLatestPassing } from "./history-live-gates.js";
import {
  HISTORY_STAGING_PREFIX,
  HistoryEntryCommittedError,
  isHistoryEntryCommittedError,
  reconcileHistoryPointers,
  writeHistoryEntry,
  type HistoryFileSidecar,
  type HistorySidecar,
  type WriteEntryOptions
} from "./history-entry-write.js";

export {
  HistoryEntryCommittedError,
  isHistoryEntryCommittedError,
  type HistoryFileSidecar,
  type HistorySidecar,
  type WriteEntryOptions
};

export type { HistoryPointerKind } from "./history-files.js";

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
  return writeHistoryEntry({
    layout, benchName, slug, payload, report: reportMarkdown,
    findings: findingsMarkdown, options,
    entryAllowsPassing: () => entryAllowsLatestPassing(layout, benchName, slug, payload)
  });
}

export async function reconcileHistoryEntryPointers(
  layout: HistoryLayout,
  benchName: BenchName,
  entry: HistoryEntry,
  payload: KpiPayload,
  findings: string | null,
  pointerWriter?: WriteEntryOptions["pointerWriter"]
): Promise<void> {
  return reconcileHistoryPointers({
    layout, benchName, entry, payload, findings,
    entryAllowsPassing: () => entryAllowsLatestPassing(
      layout, benchName, entry.slug, payload
    ),
    options: { pointerWriter }
  });
}

// @anchor write-entry-tmp-filter: staging directories created by
// writeEntry must never surface as "slugs" to readers. Pattern matches
// `.tmp-<slug>-<mkdtemp-suffix>`. listEntries also skips any directory
// whose name does not match the canonical SLUG_PATTERN; that is a
// silent skip by design (a future archive may carry sidecar dirs like
// `evidence/` or `datasets/` at the bench root that are not slugs).
const STAGING_PREFIX = HISTORY_STAGING_PREFIX;

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
 * @anchor read-entry-for-diff-lenient — the advisory baseline-diff read must
 * not be held hostage to historical archives. Tightening KpiPayloadSchema can
 * retroactively invalidate a pre-existing archive (e.g. a negative
 * per_scenario[].latency_ms written by an old pre-monotonic-clock run). A diff
 * is advisory: when a historical archive is unparseable or fails schema
 * validation, treat it as "no comparable baseline" (return null + warn) so the
 * current run still completes and writes its own archive. The strict readEntry
 * above is preserved for integrity-critical callers (e.g. the standalone diff
 * CLI reading the CURRENT entry-under-diff) and merge-longmemeval's direct
 * KpiPayloadSchema.parse stays strict on freshly-produced shard payloads.
 * cross-file: apps/bench-runner/src/longmemeval/recall-eval-archive.ts
 * cross-file: apps/bench-runner/src/longmemeval/archive-evidence.ts
 */
export async function readEntryForDiff(
  layout: HistoryLayout,
  benchName: BenchName,
  slug: string
): Promise<KpiPayload | null> {
  try {
    return await readEntry(layout, benchName, slug);
  } catch (error) {
    const benchRoot = path.join(layout.historyRoot, benchName);
    const kpiPath = path.join(benchRoot, slug, KPI_FILENAME);
    if (error instanceof ZodError) {
      console.warn(
        `[bench-history] skipping baseline diff: archive '${kpiPath}' fails KpiPayloadSchema; ${error.issues
          .map((issue) => `[${issue.path.join(".")}] ${issue.message}`)
          .join("; ")}`
      );
      return null;
    }
    if (error instanceof SyntaxError) {
      console.warn(
        `[bench-history] skipping baseline diff: archive '${kpiPath}' is not valid JSON; ${error.message}`
      );
      return null;
    }
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
 * When split/policy/simulate filters are provided we ignore pointer files and
 * scan via listEntries → readEntry → filter. The scan still honors
 * `pointerKind`, so callers can ask for the newest filtered run or newest
 * filtered passing entry.
 */
export async function readLatest(
  layout: HistoryLayout,
  benchName: BenchName,
  opts: {
    split?: BenchSplit;
    policyShape?: BenchPolicyShape;
    simulateReport?: BenchSimulateReportMode;
    embeddingProvider?: string;
    pointerKind?: HistoryPointerKind;
  } = {}
): Promise<KpiPayload | null> {
  const pointerKind = opts.pointerKind ?? "run";
  if (
    opts.split !== undefined ||
    opts.policyShape !== undefined ||
    opts.simulateReport !== undefined
  ) {
    const slugs = await listEntries(layout, benchName);
    for (let i = slugs.length - 1; i >= 0; i--) {
      const slug = slugs[i];
      if (slug === undefined) continue;
      const entry = await readEntryForDiff(layout, benchName, slug);
      if (
        entry !== null &&
        (opts.split === undefined || entry.split === opts.split) &&
        (opts.policyShape === undefined ||
          (entry.policy_shape ?? "stress") === opts.policyShape) &&
        (opts.simulateReport === undefined ||
          (entry.simulate_report ?? "none") === opts.simulateReport) &&
        (opts.embeddingProvider === undefined ||
          entry.embedding_provider === opts.embeddingProvider) &&
        (pointerKind === "run" ||
          (await entryIsPassing(layout, benchName, slug, entry)))
      ) {
        return entry;
      }
    }
    return null;
  }

  const pointerFilename =
    opts.embeddingProvider === undefined
      ? latestPointerFilename(pointerKind)
      : latestProviderPointerFilename(pointerKind, opts.embeddingProvider);
  const pointerSlug = await readLatestPointerSlug(layout, benchName, pointerFilename);
  if (pointerSlug !== null) {
    const pointed = await readEntryForDiff(layout, benchName, pointerSlug);
    if (
      pointed !== null &&
      (opts.embeddingProvider === undefined ||
        pointed.embedding_provider === opts.embeddingProvider) &&
      (pointerKind === "run" ||
        (await entryIsPassing(layout, benchName, pointerSlug, pointed)))
    ) {
      return pointed;
    }
  }
  const legacyPointer =
    pointerKind === "passing" && opts.embeddingProvider === undefined
      ? await readLatestPointerSlug(layout, benchName, LATEST_BASELINE_FILENAME)
      : null;
  if (legacyPointer !== null) {
    const pointed = await readEntryForDiff(layout, benchName, legacyPointer);
    if (
      pointed !== null &&
      (await entryIsPassing(layout, benchName, legacyPointer, pointed))
    ) {
      return pointed;
    }
  }
  const slugs = await listEntries(layout, benchName);
  if (slugs.length === 0) return null;
  for (let i = slugs.length - 1; i >= 0; i -= 1) {
    const slug = slugs[i];
    if (slug === undefined) continue;
    const entry = await readEntryForDiff(layout, benchName, slug);
    if (
      entry !== null &&
      (opts.embeddingProvider === undefined ||
        entry.embedding_provider === opts.embeddingProvider) &&
      (pointerKind === "run" ||
        (await entryIsPassing(layout, benchName, slug, entry)))
    ) {
      return entry;
    }
  }
  return null;
}

async function readLatestPointerSlug(
  layout: HistoryLayout,
  benchName: BenchName,
  filename: string = LATEST_RUN_FILENAME
): Promise<string | null> {
  const pointerPath = path.join(layout.historyRoot, benchName, filename);
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

async function entryIsPassing(
  layout: HistoryLayout,
  benchName: BenchName,
  slug: string,
  payload: KpiPayload
): Promise<boolean> {
  const findingsPath = path.join(layout.historyRoot, benchName, slug, FINDINGS_FILENAME);
  try {
    await access(findingsPath);
    return false;
  } catch (error) {
    if (isNotFound(error)) {
      return await entryAllowsLatestPassing(layout, benchName, slug, payload);
    }
    throw error;
  }
}

async function entryAllowsLatestPassing(
  layout: HistoryLayout,
  benchName: BenchName,
  slug: string,
  payload: KpiPayload
): Promise<boolean> {
  // @anchor seed-extraction-release-blocker
  // Evaluate the seed-extraction blocker before any branch so degraded
  // provenance (no_credentials_fallback, offline_fallbacks > 0, or missing
  // path on LongMemEval) cannot reach latest_passing through the
  // live-strict-real sidecar branch, which would otherwise short-circuit
  // releaseHardGateAllowsLatestPassing.
  if (evaluateSeedExtractionReleaseBlocker(payload) !== null) {
    return false;
  }
  if (payload.bench_name === "live" && payload.split === "strict-real") {
    return await liveGatesSidecarAllowsLatestPassing(
      path.join(layout.historyRoot, benchName, slug, LIVE_GATES_FILENAME),
      isNotFound
    );
  }
  return releaseHardGateAllowsLatestPassing(payload);
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
  return await readEntryForDiff(layout, benchName, previousSlug);
}

function isNotFound(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code: string }).code === "ENOENT"
  );
}
