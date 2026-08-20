import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type {
  LongMemEvalDiagnosticsSidecar,
  LongMemEvalQuestionDiagnostic
} from "./schema/diagnostics-types.js";
import { throwLifecycleErrors } from "../lifecycle/errors.js";
import {
  writeDiagnosticsGzipStream,
  type StreamedArtifactIdentity
} from "./artifacts/artifact-gzip-stream.js";

export interface DiagnosticsSpoolArtifactIdentity extends StreamedArtifactIdentity {
  readonly artifactPath: string;
}

interface SealedSpoolIdentity extends StreamedArtifactIdentity {
  readonly questionCount: number;
}

export class LongMemEvalDiagnosticsSpool {
  readonly rootPath: string;
  readonly #spoolPath: string;
  readonly #sourceHash = createHash("sha256");
  #disposed = false;
  #questionCount = 0;
  #sourceBytes = 0;
  #sealedIdentity: SealedSpoolIdentity | null = null;

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
    this.#assertWritable();
    const line = Buffer.from(`${JSON.stringify(question)}\n`, "utf8");
    await appendFile(this.#spoolPath, line);
    this.#sourceHash.update(line);
    this.#sourceBytes += line.byteLength;
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
    const sealedIdentity = this.#seal();
    await mkdir(dirname(artifactPath), { recursive: true });
    const identity = await writeDiagnosticsGzipStream(
      artifactPath,
      sidecar,
      this.#readQuestions(sealedIdentity)
    );
    return { artifactPath, ...identity };
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    await rm(this.rootPath, { recursive: true, force: true });
    this.#disposed = true;
  }

  async *#readQuestions(
    expected: SealedSpoolIdentity
  ): AsyncGenerator<LongMemEvalQuestionDiagnostic> {
    const actualHash = createHash("sha256");
    const decoder = new StringDecoder("utf8");
    let pending = "";
    let bytes = 0;
    let questionCount = 0;
    for await (const chunk of createReadStream(this.#spoolPath)) {
      const raw = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      actualHash.update(raw);
      bytes += raw.byteLength;
      pending += decoder.write(raw);
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line.length > 0) {
          questionCount += 1;
          yield JSON.parse(line) as LongMemEvalQuestionDiagnostic;
        }
        newline = pending.indexOf("\n");
      }
    }
    pending += decoder.end();
    if (pending.length > 0) {
      questionCount += 1;
      yield JSON.parse(pending) as LongMemEvalQuestionDiagnostic;
    }
    assertSealedSpoolIdentity(expected, {
      bytes,
      sha256: actualHash.digest("hex"),
      questionCount
    });
  }

  #seal(): SealedSpoolIdentity {
    if (this.#sealedIdentity === null) {
      this.#sealedIdentity = {
        bytes: this.#sourceBytes,
        sha256: this.#sourceHash.digest("hex"),
        questionCount: this.#questionCount
      };
    }
    return this.#sealedIdentity;
  }

  #assertWritable(): void {
    this.#assertActive();
    if (this.#sealedIdentity !== null) {
      throw new Error("diagnostics spool is sealed");
    }
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("diagnostics spool is disposed");
  }
}

function assertSealedSpoolIdentity(
  expected: SealedSpoolIdentity,
  actual: SealedSpoolIdentity
): void {
  if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256 ||
      actual.questionCount !== expected.questionCount) {
    throw new Error("diagnostics spool sealed identity mismatch");
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
