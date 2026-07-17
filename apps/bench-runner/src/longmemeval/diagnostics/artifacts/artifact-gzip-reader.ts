import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import type { LongMemEvalDiagnosticsSidecar } from "../schema/diagnostics-types.js";
import { DiagnosticsJsonStreamReader } from "../artifacts/artifact-json-reader.js";
import {
  artifactSourceLabel,
  createArtifactReadStream,
  decodeArtifactUtf8,
  type ArtifactReadSource
} from "../artifacts/artifact-utf8.js";

export async function readDiagnosticsGzipStream(
  artifactPath: ArtifactReadSource,
  options: { readonly maxQuestionChars?: number } = {}
): Promise<LongMemEvalDiagnosticsSidecar> {
  const source = createArtifactReadStream(artifactPath);
  return readDiagnosticsGzipSource(
    source,
    artifactSourceLabel(artifactPath),
    options
  );
}

export async function readDiagnosticsGzipBytes(
  contents: Uint8Array,
  options: { readonly maxQuestionChars?: number } = {}
): Promise<LongMemEvalDiagnosticsSidecar> {
  return readDiagnosticsGzipSource(
    Readable.from([contents]),
    "verified full_diagnostics bytes",
    options
  );
}

async function readDiagnosticsGzipSource(
  source: Readable,
  sourceLabel: string,
  options: { readonly maxQuestionChars?: number }
): Promise<LongMemEvalDiagnosticsSidecar> {
  const gunzip = createGunzip();
  const reader = new DiagnosticsJsonStreamReader(options.maxQuestionChars);
  source.once("error", (error) => gunzip.destroy(error));
  source.pipe(gunzip);
  try {
    for await (const chunk of decodeArtifactUtf8(gunzip)) reader.consume(chunk);
    return reader.finish();
  } catch (error) {
    source.destroy();
    gunzip.destroy();
    if (hasCode(error, "ENOENT")) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `failed to read gzip diagnostics ${sourceLabel}: ${message}`
    );
  }
}

export async function* streamDiagnosticsGzipQuestions(
  artifactPath: ArtifactReadSource,
  options: {
    readonly maxQuestionChars?: number;
    readonly observeArtifactChunk?: (chunk: Uint8Array) => void;
  } = {}
): AsyncGenerator<LongMemEvalDiagnosticsSidecar["questions"][number]> {
  const source = createArtifactReadStream(artifactPath);
  const gunzip = createGunzip();
  const reader = new DiagnosticsJsonStreamReader(options.maxQuestionChars, true);
  if (options.observeArtifactChunk !== undefined) {
    const observe = options.observeArtifactChunk;
    source.on("data", (chunk: string | Buffer) => {
      observe(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
  }
  source.once("error", (error) => gunzip.destroy(error));
  source.pipe(gunzip);
  try {
    for await (const chunk of decodeArtifactUtf8(gunzip)) {
      reader.consume(chunk);
      yield* reader.takeQuestions();
    }
    reader.finish();
    yield* reader.takeQuestions();
  } catch (error) {
    source.destroy();
    gunzip.destroy();
    if (hasCode(error, "ENOENT")) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `failed to stream gzip diagnostics ${artifactSourceLabel(artifactPath)}: ${message}`
    );
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" &&
    "code" in error && (error as { readonly code: unknown }).code === code;
}
