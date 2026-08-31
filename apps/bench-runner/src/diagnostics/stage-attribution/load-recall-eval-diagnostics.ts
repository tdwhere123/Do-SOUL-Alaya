import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { DiagnosticsJsonStreamReader } from "../../artifacts/artifact-json-reader.js";
import { decodeArtifactUtf8 } from "../../artifacts/artifact-utf8.js";
import { LongMemEvalQuestionDiagnosticSchema } from "../schema/diagnostics-schema.js";
import type { LongMemEvalQuestionDiagnostic } from "../schema/diagnostics-types.js";

/**
 * Stream nested `recall-eval-diagnostics.json.gz` → question diagnostics.
 * Offline-only; does not invent stage 2/3 from F0 waist absence.
 */
export async function loadRecallEvalQuestionDiagnostics(
  artifactPath: string
): Promise<readonly LongMemEvalQuestionDiagnostic[]> {
  const questions: LongMemEvalQuestionDiagnostic[] = [];
  for await (const question of streamRecallEvalQuestionDiagnostics(artifactPath)) {
    questions.push(question);
  }
  return questions;
}

export async function* streamRecallEvalQuestionDiagnostics(
  artifactPath: string
): AsyncGenerator<LongMemEvalQuestionDiagnostic> {
  const source = createReadStream(artifactPath);
  const gunzip = createGunzip();
  // schema_version 2: recall_eval_diagnostics wraps each row's nested diagnostics.
  const reader = new DiagnosticsJsonStreamReader<LongMemEvalQuestionDiagnostic>(
    undefined,
    true,
    parseRecallEvalWrappedQuestion,
    2
  );
  source.once("error", (error) => gunzip.destroy(error));
  source.pipe(gunzip);
  try {
    for await (const chunk of decodeArtifactUtf8(gunzip)) {
      reader.consume(chunk);
      yield* reader.takeQuestions();
    }
    const finished = reader.finish() as { readonly kind?: string };
    if (finished.kind !== "recall_eval_diagnostics") {
      throw new Error(
        `expected kind=recall_eval_diagnostics at ${artifactPath}, got ${String(finished.kind)}`
      );
    }
    yield* reader.takeQuestions();
  } catch (error) {
    source.destroy();
    gunzip.destroy();
    if (hasCode(error, "ENOENT")) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to stream recall-eval diagnostics ${artifactPath}: ${message}`);
  }
}

function parseRecallEvalWrappedQuestion(
  value: unknown,
  index: number
): LongMemEvalQuestionDiagnostic {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`recall-eval diagnostics question[${index}] must be an object`);
  }
  const row = value as { readonly diagnostics?: unknown };
  if (row.diagnostics === undefined || row.diagnostics === null) {
    throw new Error(
      `recall-eval diagnostics question[${index}] missing nested diagnostics`
    );
  }
  return LongMemEvalQuestionDiagnosticSchema.parse(row.diagnostics);
}

function hasCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { readonly code: unknown }).code === code
  );
}
