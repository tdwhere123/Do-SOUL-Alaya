import { randomBytes } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type HistoryPointerKind = "run" | "passing";

export const KPI_FILENAME = "kpi.json";
export const REPORT_FILENAME = "report.md";
export const FINDINGS_FILENAME = "findings.md";
export const LATEST_BASELINE_FILENAME = "latest-baseline.json";
export const LATEST_BASELINE_EMBEDDING_ON_FILENAME = "latest-baseline-embedding-on.json";
export const LATEST_RUN_FILENAME = "latest-run.json";
export const LATEST_PASSING_FILENAME = "latest-passing.json";
export const LATEST_RUN_EMBEDDING_OFF_FILENAME = "latest-run-embedding-off.json";
export const LATEST_RUN_EMBEDDING_ON_FILENAME = "latest-run-embedding-on.json";
export const LATEST_PASSING_EMBEDDING_OFF_FILENAME = "latest-passing-embedding-off.json";
export const LATEST_PASSING_EMBEDDING_ON_FILENAME = "latest-passing-embedding-on.json";
export const LIVE_GATES_FILENAME = "live-gates.json";

export function latestPointerFilename(kind: HistoryPointerKind): string {
  return kind === "run" ? LATEST_RUN_FILENAME : LATEST_PASSING_FILENAME;
}

export function latestProviderPointerFilename(
  kind: HistoryPointerKind,
  embeddingProvider: string
): string {
  const embeddingOn = embeddingProvider !== "none";
  if (kind === "run") {
    return embeddingOn ? LATEST_RUN_EMBEDDING_ON_FILENAME : LATEST_RUN_EMBEDDING_OFF_FILENAME;
  }
  return embeddingOn ? LATEST_PASSING_EMBEDDING_ON_FILENAME : LATEST_PASSING_EMBEDDING_OFF_FILENAME;
}

export async function writePointer(
  benchRoot: string,
  filename: string,
  slug: string,
  kpiPath: string
): Promise<void> {
  const pointerPath = path.join(benchRoot, filename);
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
}

export async function writeLegacyBaselinePointer(
  benchRoot: string,
  embeddingProvider: string,
  slug: string,
  kpiPath: string
): Promise<void> {
  await writePointer(benchRoot, LATEST_BASELINE_FILENAME, slug, kpiPath);
  if (embeddingProvider !== "none") {
    await writePointer(benchRoot, LATEST_BASELINE_EMBEDDING_ON_FILENAME, slug, kpiPath);
  }
}

export function validateSidecarFilename(filename: string): void {
  const reserved = new Set([
    KPI_FILENAME,
    REPORT_FILENAME,
    FINDINGS_FILENAME,
    LATEST_BASELINE_FILENAME,
    LATEST_BASELINE_EMBEDDING_ON_FILENAME,
    LATEST_RUN_FILENAME,
    LATEST_PASSING_FILENAME,
    LATEST_RUN_EMBEDDING_OFF_FILENAME,
    LATEST_RUN_EMBEDDING_ON_FILENAME,
    LATEST_PASSING_EMBEDDING_OFF_FILENAME,
    LATEST_PASSING_EMBEDDING_ON_FILENAME
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
