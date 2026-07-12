import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import { writeDiagnosticsGzipStream } from "./diagnostics/artifact-gzip-stream.js";
import {
  readDiagnosticsGzipStream,
  streamDiagnosticsGzipQuestions
} from "./diagnostics/artifact-gzip-reader.js";
import {
  readDiagnosticsJsonStream,
  streamDiagnosticsJsonQuestions
} from "./diagnostics/artifact-json-stream.js";
import type { LongMemEvalDiagnosticsSidecar } from "./diagnostics.js";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

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

export async function writeExternalGzipDiagnosticsArtifact(input: {
  readonly historyRoot: string;
  readonly benchName: string;
  readonly slug: string;
  readonly filename: string;
  readonly contents: string;
}): Promise<{ readonly artifactPath: string; readonly bytes: Buffer }> {
  if (!input.filename.endsWith(".json.gz")) {
    throw new Error("gzip diagnostics artifact filename must end with .json.gz");
  }
  const artifactPath = path.join(
    resolveBenchDiagnosticsArtifactRoot(input.historyRoot),
    input.benchName,
    input.slug,
    input.filename
  );
  const bytes = await gzipAsync(Buffer.from(input.contents, "utf8"));
  await mkdir(path.dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, bytes);
  return { artifactPath, bytes };
}

export async function writeExternalGzipDiagnosticsSidecarArtifact(input: {
  readonly historyRoot: string;
  readonly benchName: string;
  readonly slug: string;
  readonly filename: string;
  readonly sidecar: LongMemEvalDiagnosticsSidecar;
}): Promise<{
  readonly artifactPath: string;
  readonly bytes: number;
  readonly sha256: string;
}> {
  if (!input.filename.endsWith(".json.gz")) {
    throw new Error("gzip diagnostics artifact filename must end with .json.gz");
  }
  const artifactPath = resolveArtifactPath(input);
  await mkdir(path.dirname(artifactPath), { recursive: true });
  const identity = await writeDiagnosticsGzipStream(artifactPath, input.sidecar);
  return { artifactPath, ...identity };
}

export async function readExternalDiagnosticsArtifact(
  artifactPath: string
): Promise<string> {
  const bytes = await readFile(artifactPath);
  if (!artifactPath.endsWith(".gz")) {
    return bytes.toString("utf8");
  }
  return (await gunzipAsync(bytes)).toString("utf8");
}

export async function readExternalDiagnosticsSidecarArtifact(
  artifactPath: string,
  options: { readonly maxQuestionChars?: number } = {}
): Promise<LongMemEvalDiagnosticsSidecar> {
  if (artifactPath.endsWith(".gz")) {
    return readDiagnosticsGzipStream(artifactPath, options);
  }
  return readDiagnosticsJsonStream(artifactPath, options);
}

export function streamExternalDiagnosticsQuestions(
  artifactPath: string
): AsyncIterable<LongMemEvalDiagnosticsSidecar["questions"][number]> {
  return artifactPath.endsWith(".gz")
    ? streamDiagnosticsGzipQuestions(artifactPath)
    : streamDiagnosticsJsonQuestions(artifactPath);
}

function resolveArtifactPath(input: {
  readonly historyRoot: string;
  readonly benchName: string;
  readonly slug: string;
  readonly filename: string;
}): string {
  return path.join(
    resolveBenchDiagnosticsArtifactRoot(input.historyRoot),
    input.benchName,
    input.slug,
    input.filename
  );
}
