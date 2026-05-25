import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export function resolveBenchDiagnosticsArtifactRoot(historyRoot: string): string {
  const configured = process.env.ALAYA_BENCH_ARTIFACT_ROOT?.trim();
  if (configured !== undefined && configured.length > 0) {
    return path.resolve(configured);
  }
  const resolvedHistoryRoot = path.resolve(historyRoot);
  const parent = path.dirname(resolvedHistoryRoot);
  const artifactBase =
    path.basename(resolvedHistoryRoot) === "bench-history" &&
    path.basename(parent) === "docs"
      ? path.dirname(parent)
      : parent;
  return path.join(artifactBase, ".bench-artifacts");
}

export async function writeExternalDiagnosticsArtifact(input: {
  readonly historyRoot: string;
  readonly benchName: string;
  readonly slug: string;
  readonly filename: string;
  readonly contents: string;
}): Promise<string> {
  const artifactPath = path.join(
    resolveBenchDiagnosticsArtifactRoot(input.historyRoot),
    input.benchName,
    input.slug,
    input.filename
  );
  await mkdir(path.dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, input.contents, "utf8");
  return artifactPath;
}
