import { createReadStream } from "node:fs";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type {
  LongMemEvalDiagnosticsSidecar,
  LongMemEvalQuestionDiagnostic
} from "../diagnostics-types.js";
import { throwLifecycleErrors } from "../lifecycle/errors.js";
import {
  writeDiagnosticsGzipStream,
  type StreamedArtifactIdentity
} from "./artifact-gzip-stream.js";

export interface DiagnosticsSpoolArtifactIdentity extends StreamedArtifactIdentity {
  readonly artifactPath: string;
}

export class LongMemEvalDiagnosticsSpool {
  readonly rootPath: string;
  readonly #spoolPath: string;
  #disposed = false;
  #questionCount = 0;

  private constructor(rootPath: string) {
    this.rootPath = rootPath;
    this.#spoolPath = join(rootPath, "questions.ndjson");
  }

  static async create(): Promise<LongMemEvalDiagnosticsSpool> {
    const root = await mkdtemp(join(tmpdir(), "alaya-lme-diagnostics-"));
    const spool = new LongMemEvalDiagnosticsSpool(root);
    try {
      await writeFile(spool.#spoolPath, "", { encoding: "utf8", flag: "wx" });
      return spool;
    } catch (error) {
      return await removeFailedSpoolRoot(root, error);
    }
  }

  get questionCount(): number {
    return this.#questionCount;
  }

  async append(
    question: LongMemEvalQuestionDiagnostic
  ): Promise<LongMemEvalQuestionDiagnostic> {
    this.#assertActive();
    await appendFile(this.#spoolPath, `${JSON.stringify(question)}\n`, "utf8");
    this.#questionCount += 1;
    return compactRetainedDiagnostic(question);
  }

  async writeGzipArtifact(
    artifactPath: string,
    sidecar: LongMemEvalDiagnosticsSidecar
  ): Promise<DiagnosticsSpoolArtifactIdentity> {
    this.#assertActive();
    if (sidecar.questions.length !== this.#questionCount) {
      throw new Error("diagnostics spool question count does not match archive sidecar");
    }
    await mkdir(dirname(artifactPath), { recursive: true });
    const identity = await writeDiagnosticsGzipStream(
      artifactPath,
      sidecar,
      this.#readQuestions()
    );
    return { artifactPath, ...identity };
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    await rm(this.rootPath, { recursive: true, force: true });
    this.#disposed = true;
  }

  async *#readQuestions(): AsyncGenerator<LongMemEvalQuestionDiagnostic> {
    const lines = createInterface({
      input: createReadStream(this.#spoolPath, { encoding: "utf8" }),
      crlfDelay: Infinity
    });
    for await (const line of lines) {
      if (line.length === 0) continue;
      yield JSON.parse(line) as LongMemEvalQuestionDiagnostic;
    }
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("diagnostics spool is disposed");
  }
}

async function removeFailedSpoolRoot(root: string, primaryError: unknown): Promise<never> {
  try {
    await rm(root, { recursive: true, force: true });
  } catch (cleanupError) {
    throw new AggregateError([primaryError, cleanupError], "diagnostics spool creation failed");
  }
  throw primaryError;
}

export async function withLongMemEvalDiagnosticsSpool<T>(
  run: (spool: LongMemEvalDiagnosticsSpool) => Promise<T>
): Promise<T> {
  const spool = await LongMemEvalDiagnosticsSpool.create();
  let result: T | undefined;
  let primaryError: unknown;
  try {
    result = await run(spool);
  } catch (error) {
    primaryError = error;
  }
  let cleanupError: unknown;
  try {
    await spool.dispose();
  } catch (error) {
    cleanupError = error;
  }
  throwLifecycleErrors("LongMemEval diagnostics spool lifecycle failed", [
    primaryError,
    cleanupError
  ]);
  return result as T;
}

function compactRetainedDiagnostic(
  question: LongMemEvalQuestionDiagnostic
): LongMemEvalQuestionDiagnostic {
  return {
    ...question,
    candidates: []
  };
}
