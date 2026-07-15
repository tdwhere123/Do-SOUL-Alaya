import type { LongMemEvalDiagnosticsSidecar } from "../diagnostics-types.js";
import { DiagnosticsJsonStreamReader } from "./artifact-json-reader.js";
import {
  artifactSourceLabel,
  createArtifactReadStream,
  decodeArtifactUtf8,
  type ArtifactReadSource
} from "./artifact-utf8.js";

export async function readDiagnosticsJsonStream(
  artifactPath: ArtifactReadSource,
  options: { readonly maxQuestionChars?: number } = {}
): Promise<LongMemEvalDiagnosticsSidecar> {
  const reader = new DiagnosticsJsonStreamReader(options.maxQuestionChars);
  const source = createArtifactReadStream(artifactPath);
  try {
    for await (const chunk of decodeArtifactUtf8(source)) reader.consume(chunk);
    return reader.finish();
  } catch (error) {
    source.destroy();
    if (hasCode(error, "ENOENT")) throw error;
    throw contextualError("read", artifactSourceLabel(artifactPath), error);
  }
}

export async function* streamDiagnosticsJsonQuestions(
  artifactPath: ArtifactReadSource,
  options: {
    readonly maxQuestionChars?: number;
    readonly observeArtifactChunk?: (chunk: Uint8Array) => void;
  } = {}
): AsyncGenerator<LongMemEvalDiagnosticsSidecar["questions"][number]> {
  const reader = new DiagnosticsJsonStreamReader(options.maxQuestionChars, true);
  const source = createArtifactReadStream(artifactPath);
  try {
    for await (const chunk of decodeArtifactUtf8(source, options.observeArtifactChunk)) {
      reader.consume(chunk);
      yield* reader.takeQuestions();
    }
    reader.finish();
    yield* reader.takeQuestions();
  } catch (error) {
    source.destroy();
    if (hasCode(error, "ENOENT")) throw error;
    throw contextualError("stream", artifactSourceLabel(artifactPath), error);
  }
}

function contextualError(action: string, artifactPath: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`failed to ${action} JSON diagnostics ${artifactPath}: ${message}`);
}

function hasCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" &&
    "code" in error && (error as { readonly code: unknown }).code === code;
}
