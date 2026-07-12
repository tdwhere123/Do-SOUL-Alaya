import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import {
  readQuestionMissTaxonomy,
  summarizeLongMemEvalMissTaxonomy
} from "../diagnostics-miss-taxonomy.js";
import type {
  LongMemEvalDiagnosticsSidecar,
  LongMemEvalQuestionDiagnostic
} from "../diagnostics-types.js";

export interface StreamedArtifactIdentity {
  readonly bytes: number;
  readonly sha256: string;
}

export async function writeDiagnosticsGzipStream(
  artifactPath: string,
  sidecar: LongMemEvalDiagnosticsSidecar,
  questions: AsyncIterable<LongMemEvalQuestionDiagnostic> = fromArray(sidecar.questions)
): Promise<StreamedArtifactIdentity> {
  const temporaryPath = `${artifactPath}.${process.pid}.${randomUUID()}.tmp`;
  const meter = new ArtifactIdentityMeter();
  try {
    await pipeline(
      Readable.from(renderSidecarChunks(sidecar, questions)),
      createGzip(),
      meter,
      createWriteStream(temporaryPath, { flags: "wx" })
    );
    await rename(temporaryPath, artifactPath);
    return meter.identity();
  } catch (error) {
    return await removeTemporaryArtifact(temporaryPath, error);
  }
}

async function* renderSidecarChunks(
  sidecar: LongMemEvalDiagnosticsSidecar,
  questions: AsyncIterable<LongMemEvalQuestionDiagnostic>
): AsyncGenerator<string> {
  const summary = sidecar.miss_taxonomy_summary ??
    summarizeLongMemEvalMissTaxonomy(sidecar.questions);
  let wroteProperty = false;
  let wroteSummary = false;
  yield "{";
  for (const key of Object.keys(sidecar)) {
    if (key === "miss_taxonomy_summary") wroteSummary = true;
    if (key === "questions") {
      yield wroteProperty ? "," : "";
      yield* renderQuestionsProperty(key, questions);
      wroteProperty = true;
      continue;
    }
    const value = key === "miss_taxonomy_summary"
      ? summary
      : sidecar[key as keyof LongMemEvalDiagnosticsSidecar];
    const rendered = JSON.stringify(value);
    if (rendered === undefined) continue;
    yield wroteProperty ? "," : "";
    yield `${JSON.stringify(key)}:${rendered}`;
    wroteProperty = true;
  }
  if (!wroteSummary) {
    yield wroteProperty ? "," : "";
    yield `${JSON.stringify("miss_taxonomy_summary")}:${JSON.stringify(summary)}`;
  }
  yield "}\n";
}

async function* renderQuestionsProperty(
  key: string,
  questions: AsyncIterable<LongMemEvalQuestionDiagnostic>
): AsyncGenerator<string> {
  yield `${JSON.stringify(key)}:[`;
  let first = true;
  for await (const question of questions) {
    yield first ? "" : ",";
    yield JSON.stringify({
      ...question,
      miss_taxonomy: readQuestionMissTaxonomy(question)
    });
    first = false;
  }
  yield "]";
}

async function* fromArray(
  questions: readonly LongMemEvalQuestionDiagnostic[]
): AsyncGenerator<LongMemEvalQuestionDiagnostic> {
  yield* questions;
}

class ArtifactIdentityMeter extends Transform {
  readonly #hash = createHash("sha256");
  #bytes = 0;

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void
  ): void {
    this.#hash.update(chunk);
    this.#bytes += chunk.byteLength;
    callback(null, chunk);
  }

  identity(): StreamedArtifactIdentity {
    return { bytes: this.#bytes, sha256: this.#hash.digest("hex") };
  }
}

async function removeTemporaryArtifact(path: string, primaryError: unknown): Promise<never> {
  try {
    await unlink(path);
  } catch (cleanupError) {
    if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new AggregateError([primaryError, cleanupError], "diagnostics gzip write failed");
    }
  }
  throw primaryError;
}
