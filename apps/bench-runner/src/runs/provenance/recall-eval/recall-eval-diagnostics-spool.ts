import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { TextDecoder } from "node:util";
import type { RecallEvalQuestionResult } from
  "../../lifecycle/recall-eval/recall-eval-contract.js";
import { throwLifecycleErrors } from "../../lifecycle/errors.js";
import type {
  EmbeddingSupplementRuntimeProvenance,
  LocalCrossEncoderRuntimeProvenance
} from "../embedding/local-onnx.js";
import { RecallEvalDiagnosticsSummaryAccumulator } from
  "./diagnostics/recall-eval-diagnostics-summary.js";
import {
  RecallEvalDiagnosticsQuestionSchema,
  assertRecallEvalDiagnosticsCrossQuestion,
  assertRecallEvalDiagnosticsCrossScores,
  assertRecallEvalDiagnosticsQuestionRuntime,
  buildRecallEvalDiagnosticsHeader,
  normalizeRecallEvalDiagnosticsQuestion,
  writeRecallEvalDiagnosticsGzipFromQuestions,
  type RecallEvalDiagnosticsQuestion
} from "./recall-eval-diagnostics.js";

type RuntimeInput = Readonly<{
  embeddingSupplement: EmbeddingSupplementRuntimeProvenance;
  answerRerank: LocalCrossEncoderRuntimeProvenance;
}>;

type ArtifactInput = RuntimeInput & Readonly<{
  retainedQuestions: readonly RecallEvalQuestionResult[];
}>;

type RowBinding = Readonly<{
  questionId: string;
  deliveredResultsSha256: string;
}>;

type SealedIdentity = Readonly<{
  bytes: number;
  sha256: string;
  questionCount: number;
}>;

export class RecallEvalDiagnosticsSpool {
  readonly rootPath: string;
  readonly #handle: FileHandle;
  readonly #sourceHash = createHash("sha256");
  readonly #bindings: RowBinding[] = [];
  #sourceBytes = 0;
  #sealPromise: Promise<SealedIdentity> | null = null;
  #appendQueue: Promise<void> = Promise.resolve();
  #artifactQueue: Promise<void> = Promise.resolve();
  #appendError: unknown;
  #disposePromise: Promise<void> | null = null;
  #closing = false;
  #disposed = false;

  private constructor(rootPath: string, handle: FileHandle) {
    this.rootPath = rootPath;
    this.#handle = handle;
  }

  static async create(): Promise<RecallEvalDiagnosticsSpool> {
    const root = await mkdtemp(join(tmpdir(), "alaya-recall-eval-diagnostics-"));
    const spoolPath = join(root, "recall-eval-questions.ndjson");
    try {
      return new RecallEvalDiagnosticsSpool(root, await open(spoolPath, "wx+", 0o600));
    } catch (error) {
      return removeFailedRoot(root, error);
    }
  }

  async append(question: RecallEvalQuestionResult): Promise<RecallEvalQuestionResult> {
    this.#assertWritable();
    const operation = this.#appendQueue.then(() => {
      if (this.#appendError !== undefined) throw this.#appendError;
      return this.#appendQuestion(question);
    });
    this.#appendQueue = operation.then(
      () => undefined,
      (error) => { this.#appendError ??= error; }
    );
    return operation;
  }

  async #appendQuestion(
    question: RecallEvalQuestionResult
  ): Promise<RecallEvalQuestionResult> {
    const normalized = normalizeRecallEvalDiagnosticsQuestion(question);
    const encoded = Buffer.from(`${JSON.stringify(normalized)}\n`, "utf8");
    await this.#handle.writeFile(encoded);
    this.#sourceHash.update(encoded);
    this.#sourceBytes += encoded.byteLength;
    this.#bindings.push(bindingForQuestion(question));
    return compactQuestion(question);
  }

  async writeGzipArtifact(
    artifactPath: string,
    input: ArtifactInput
  ): Promise<Readonly<{ artifactPath: string; bytes: number; sha256: string }>> {
    this.#assertActive();
    const sealed = this.#sealForRead();
    const operation = this.#artifactQueue.then(() =>
      this.#writeGzipArtifact(artifactPath, input, sealed));
    this.#artifactQueue = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }

  async #writeGzipArtifact(
    artifactPath: string,
    input: ArtifactInput,
    sealedPromise: Promise<SealedIdentity>
  ): Promise<Readonly<{ artifactPath: string; bytes: number; sha256: string }>> {
    const sealed = await sealedPromise;
    assertRetainedBindings(input.retainedQuestions, this.#bindings);
    const summary = await this.#preflight(sealed, input);
    const header = buildRecallEvalDiagnosticsHeader({ summary, ...input });
    await mkdir(dirname(artifactPath), { recursive: true });
    const identity = await writeRecallEvalDiagnosticsGzipFromQuestions(
      artifactPath,
      header,
      this.#readQuestions(sealed, this.#bindings)
    );
    return { artifactPath, ...identity };
  }

  dispose(): Promise<void> {
    if (this.#disposePromise === null) {
      this.#closing = true;
      this.#disposePromise = this.#disposeOwned();
    }
    return this.#disposePromise;
  }

  async #disposeOwned(): Promise<void> {
    await this.#appendQueue;
    await this.#artifactQueue;
    const appendError = this.#appendError;
    let closeError: unknown;
    try {
      await this.#handle.close();
    } catch (error) {
      closeError = error;
    }
    let removeError: unknown;
    try {
      await rm(this.rootPath, { recursive: true, force: true });
    } catch (error) {
      removeError = error;
    }
    this.#disposed = true;
    throwLifecycleErrors("Recall-eval diagnostics spool disposal failed", [
      appendError,
      closeError,
      removeError
    ]);
  }

  async #preflight(
    sealed: SealedIdentity,
    runtime: RuntimeInput
  ): Promise<ReturnType<RecallEvalDiagnosticsSummaryAccumulator["build"]>> {
    const accumulator = new RecallEvalDiagnosticsSummaryAccumulator();
    for await (const question of this.#readQuestions(sealed, this.#bindings)) {
      assertRecallEvalDiagnosticsQuestionRuntime(question, runtime.embeddingSupplement);
      assertRecallEvalDiagnosticsCrossQuestion(question, runtime.answerRerank);
      accumulator.add(question);
    }
    const summary = accumulator.build(runtime.embeddingSupplement);
    assertRecallEvalDiagnosticsCrossScores(
      summary.answer_rerank_scores,
      runtime.answerRerank
    );
    return summary;
  }

  async *#readQuestions(
    sealed: SealedIdentity,
    bindings: readonly RowBinding[]
  ): AsyncGenerator<RecallEvalDiagnosticsQuestion> {
    const reader = new CanonicalNdjsonReader(this.#handle, sealed);
    let index = 0;
    for await (const value of reader.read()) {
      const question = parseSpoolQuestion(value, index);
      assertRowBinding(question, bindings[index], index);
      index += 1;
      yield question;
    }
    if (index !== bindings.length) {
      throw new Error("recall-eval diagnostics spool question count mismatch");
    }
  }

  #sealForRead(): Promise<SealedIdentity> {
    if (this.#sealPromise === null) {
      this.#sealPromise = this.#appendQueue.then(() => {
        if (this.#appendError !== undefined) throw this.#appendError;
        return {
          bytes: this.#sourceBytes,
          sha256: this.#sourceHash.digest("hex"),
          questionCount: this.#bindings.length
        };
      });
    }
    return this.#sealPromise;
  }

  #assertWritable(): void {
    this.#assertActive();
    if (this.#sealPromise !== null) {
      throw new Error("recall-eval diagnostics spool is sealed");
    }
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("recall-eval diagnostics spool is disposed");
    if (this.#closing) throw new Error("recall-eval diagnostics spool is closing");
  }
}

function parseSpoolQuestion(value: unknown, index: number): RecallEvalDiagnosticsQuestion {
  const parsed = RecallEvalDiagnosticsQuestionSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`recall-eval diagnostics spool schema mismatch at ${index}`, {
      cause: parsed.error
    });
  }
  return parsed.data;
}

class CanonicalNdjsonReader {
  constructor(
    readonly handle: FileHandle,
    readonly expected: SealedIdentity
  ) {}

  async *read(): AsyncGenerator<unknown> {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let pending = "";
    let bytes = 0;
    let count = 0;
    for (let position = 0; ; position += buffer.byteLength) {
      const read = await this.handle.read(buffer, 0, buffer.byteLength, position);
      if (read.bytesRead === 0) break;
      const chunk = buffer.subarray(0, read.bytesRead);
      bytes += read.bytesRead;
      hash.update(chunk);
      pending += decoder.decode(chunk, { stream: true });
      const parsed = drainLines(pending);
      pending = parsed.pending;
      for (const value of parsed.values) {
        count += 1;
        yield value;
      }
      if (read.bytesRead < buffer.byteLength) break;
    }
    pending += decoder.decode();
    if (pending.length !== 0) {
      throw new Error("recall-eval diagnostics spool requires a final newline");
    }
    assertSourceIdentity(this.expected, {
      bytes,
      sha256: hash.digest("hex"),
      questionCount: count
    });
  }
}

function drainLines(source: string): { pending: string; values: unknown[] } {
  const parts = source.split("\n");
  const pending = parts.pop() ?? "";
  const values = parts.map((line) => {
    if (line.length === 0) throw new Error("recall-eval diagnostics spool has an empty row");
    return JSON.parse(line) as unknown;
  });
  return { pending, values };
}

function bindingForQuestion(question: RecallEvalQuestionResult): RowBinding {
  return {
    questionId: question.questionId,
    deliveredResultsSha256: deliveredResultsDigest(question.diagnostics.delivered_results)
  };
}

function assertRetainedBindings(
  questions: readonly RecallEvalQuestionResult[],
  bindings: readonly RowBinding[]
): void {
  if (questions.length !== bindings.length) {
    throw new Error("recall-eval diagnostics retained question count mismatch");
  }
  questions.forEach((question, index) => {
    const actual = bindingForQuestion(question);
    if (actual.questionId !== bindings[index]?.questionId ||
        actual.deliveredResultsSha256 !== bindings[index]?.deliveredResultsSha256) {
      throw new Error("recall-eval diagnostics retained question identity or order mismatch");
    }
  });
}

function assertRowBinding(
  question: RecallEvalDiagnosticsQuestion,
  expected: RowBinding | undefined,
  index: number
): void {
  if (expected === undefined || question.question_id !== expected.questionId ||
      deliveredResultsDigest(question.diagnostics.delivered_results) !==
        expected.deliveredResultsSha256) {
    throw new Error(`recall-eval diagnostics spool row binding mismatch at ${index}`);
  }
}

function deliveredResultsDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function compactQuestion(question: RecallEvalQuestionResult): RecallEvalQuestionResult {
  return { ...question, diagnostics: { ...question.diagnostics, candidates: [] } };
}

function assertSourceIdentity(expected: SealedIdentity, actual: SealedIdentity): void {
  if (expected.bytes !== actual.bytes || expected.sha256 !== actual.sha256 ||
      expected.questionCount !== actual.questionCount) {
    throw new Error("recall-eval diagnostics spool source identity mismatch");
  }
}

async function removeFailedRoot(root: string, primaryError: unknown): Promise<never> {
  try {
    await rm(root, { recursive: true, force: true });
  } catch (cleanupError) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "recall-eval diagnostics spool creation failed"
    );
  }
  throw primaryError;
}

export async function withRecallEvalDiagnosticsSpool<T>(
  run: (spool: RecallEvalDiagnosticsSpool) => Promise<T>
): Promise<T> {
  const spool = await RecallEvalDiagnosticsSpool.create();
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
  throwLifecycleErrors("Recall-eval diagnostics spool lifecycle failed", [
    primaryError,
    cleanupError
  ]);
  return result as T;
}
