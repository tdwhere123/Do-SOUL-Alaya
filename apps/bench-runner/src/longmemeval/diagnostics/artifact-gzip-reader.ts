import { createGunzip } from "node:zlib";
import type { LongMemEvalDiagnosticsSidecar } from "../diagnostics-types.js";
import { DiagnosticsJsonStreamReader } from "./artifact-json-reader.js";
import {
  artifactSourceLabel,
  createArtifactReadStream,
  decodeArtifactUtf8,
  type ArtifactReadSource
} from "./artifact-utf8.js";

export async function readDiagnosticsGzipStream(
  artifactPath: ArtifactReadSource,
  options: { readonly maxQuestionChars?: number } = {}
): Promise<LongMemEvalDiagnosticsSidecar> {
  const source = createArtifactReadStream(artifactPath);
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
      `failed to read gzip diagnostics ${artifactSourceLabel(artifactPath)}: ${message}`
    );
  }
}

export async function* streamDiagnosticsGzipQuestions(
  artifactPath: ArtifactReadSource,
  options: { readonly maxQuestionChars?: number } = {}
): AsyncGenerator<LongMemEvalDiagnosticsSidecar["questions"][number]> {
  const source = createArtifactReadStream(artifactPath);
  const gunzip = createGunzip();
  const reader = new DiagnosticsJsonStreamReader(options.maxQuestionChars, true);
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
