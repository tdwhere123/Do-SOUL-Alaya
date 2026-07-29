import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import {
  replayFineAssessmentSelectionBoundary,
  materializeFineAssessmentSelectionBoundary,
  type FineAssessmentSelectionBoundaryCase,
  type FineAssessmentSelectionBoundaryPendingCapture
} from "@do-soul/alaya-core";
import {
  createCompressedSizeLimit,
  forEachSelectionBoundaryGzipRecord,
  type SelectionBoundaryArtifactRecord
} from "./selection-boundary-artifact-reader.js";

// Keep full 500Q selector inputs bounded while allowing 4x the original headroom.
export const LONGMEMEVAL_SELECTION_BOUNDARY_GZIP_MAX_BYTES =
  256 * 1024 * 1024;
export const LONGMEMEVAL_SELECTION_REPLAY_ENV =
  "ALAYA_BENCH_SELECTION_REPLAY";

type SelectionBoundarySpoolCapture =
  | FineAssessmentSelectionBoundaryPendingCapture
  | FineAssessmentSelectionBoundaryCase;

export interface LongMemEvalSelectionBoundaryQuestionCapture {
  readonly observer: (capture: SelectionBoundarySpoolCapture) => undefined;
  commit(): Promise<void>;
}

export interface LongMemEvalSelectionBoundarySpool {
  readonly rootPath: string;
  beginQuestion(questionId: string): LongMemEvalSelectionBoundaryQuestionCapture;
  writeGzipArtifact(artifactPath: string): Promise<{ readonly recordCount: number }>;
  dispose(): Promise<void>;
}

type SelectionBoundaryRecord = SelectionBoundaryArtifactRecord;

interface SelectionBoundarySourceIdentity {
  readonly bytes: number;
  readonly sha256: string;
  readonly recordCount: number;
}

const SELECTION_REPLAY_ARTIFACT_ERRORS = Object.freeze({
  utf8Invalid: (context: string) =>
    `selection replay record UTF-8 is invalid (${context})`,
  jsonInvalid: (context: string) =>
    `selection replay record JSON is invalid (${context})`,
  gzipExceeded: (maxBytes: number) =>
    `selection replay gzip exceeds the ${formatByteLimit(maxBytes)} size limit`
});

export async function createLongMemEvalSelectionBoundarySpool(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly concurrency: number;
  readonly maxArtifactBytes?: number;
}): Promise<LongMemEvalSelectionBoundarySpool | null> {
  if (input.env[LONGMEMEVAL_SELECTION_REPLAY_ENV] !== "1") return null;
  if (input.concurrency !== 1) {
    throw new Error("selection replay capture requires concurrency=1");
  }
  return SelectionBoundarySpool.create(
    input.maxArtifactBytes ?? LONGMEMEVAL_SELECTION_BOUNDARY_GZIP_MAX_BYTES
  );
}

export async function verifyLongMemEvalSelectionBoundaryArtifact(
  artifactPath: string,
  maxArtifactBytes = LONGMEMEVAL_SELECTION_BOUNDARY_GZIP_MAX_BYTES
): Promise<{ readonly recordCount: number }> {
  return verifySelectionBoundaryArtifact(artifactPath, maxArtifactBytes);
}

async function verifySelectionBoundaryArtifact(
  artifactPath: string,
  maxArtifactBytes: number
): Promise<{ readonly recordCount: number }> {
  let previous: SelectionBoundaryRecord | undefined;
  const { recordCount } = await forEachSelectionBoundaryGzipRecord(
    artifactPath,
    maxArtifactBytes,
    SELECTION_REPLAY_ARTIFACT_ERRORS,
    (record) => {
      assertRecordSequence(record, previous);
      replayFineAssessmentSelectionBoundary(record.boundary);
      previous = record;
    }
  );
  if (previous !== undefined && !previous.authoritative) {
    throw new Error("selection replay question has no authoritative invocation");
  }
  return { recordCount };
}

class SelectionBoundarySpool implements LongMemEvalSelectionBoundarySpool {
  readonly #spoolPath: string;
  readonly #sourceHash = createHash("sha256");
  #disposed = false;
  #recordCount = 0;
  #sourceBytes = 0;
  #sealedIdentity: SelectionBoundarySourceIdentity | null = null;

  private constructor(
    public readonly rootPath: string,
    private readonly maxArtifactBytes: number
  ) {
    this.#spoolPath = join(rootPath, "selection-boundaries.ndjson");
  }

  static async create(maxArtifactBytes: number): Promise<SelectionBoundarySpool> {
    const root = await mkdtemp(join(tmpdir(), "alaya-selection-replay-"));
    const spool = new SelectionBoundarySpool(root, maxArtifactBytes);
    try {
      await writeFile(spool.#spoolPath, "", { encoding: "utf8", flag: "wx" });
      return spool;
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }

  beginQuestion(questionId: string): LongMemEvalSelectionBoundaryQuestionCapture {
    this.#assertWritable();
    if (questionId.length === 0) throw new Error("selection replay question id is empty");
    const pendingCaptures: SelectionBoundarySpoolCapture[] = [];
    let committed = false;
    return Object.freeze({
      observer: (capture: SelectionBoundarySpoolCapture) => {
        if (committed) throw new Error("selection replay question is committed");
        pendingCaptures.push(capture);
        return undefined;
      },
      commit: async () => {
        if (committed) throw new Error("selection replay question is committed");
        committed = true;
        this.#assertWritable();
        if (pendingCaptures.length === 0) {
          throw new Error("selection replay captured no selection invocation");
        }
        const boundaries = pendingCaptures.map((capture) =>
          "schema_version" in capture
            ? capture
            : materializeFineAssessmentSelectionBoundary(capture)
        );
        const encoded = encodeQuestionRecords(questionId, boundaries);
        await appendFile(this.#spoolPath, encoded);
        this.#sourceHash.update(encoded);
        this.#sourceBytes += encoded.byteLength;
        this.#recordCount += boundaries.length;
      }
    });
  }

  async writeGzipArtifact(
    artifactPath: string
  ): Promise<{ readonly recordCount: number }> {
    this.#assertWritable();
    const expectedSource = this.#seal();
    await mkdir(dirname(artifactPath), { recursive: true });
    const partialPath = `${artifactPath}.partial-${randomUUID()}`;
    try {
      const sourceMeter = new SourceIdentityMeter();
      await pipeline(
        createReadStream(this.#spoolPath),
        sourceMeter,
        createGzip(),
        createCompressedSizeLimit(
          this.maxArtifactBytes,
          SELECTION_REPLAY_ARTIFACT_ERRORS.gzipExceeded
        ),
        createWriteStream(partialPath, { flags: "wx" })
      );
      assertSourceIdentity(expectedSource, sourceMeter.identity());
      const verified = await verifySelectionBoundaryArtifact(
        partialPath,
        this.maxArtifactBytes
      );
      assertVerifiedRecordCount(expectedSource, verified.recordCount);
      await rename(partialPath, artifactPath);
      return verified;
    } catch (error) {
      await rm(partialPath, { force: true });
      throw error;
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await rm(this.rootPath, { recursive: true, force: true });
  }

  #assertWritable(): void {
    if (this.#disposed) throw new Error("selection replay spool is disposed");
    if (this.#sealedIdentity !== null) {
      throw new Error("selection replay spool is sealed");
    }
  }

  #seal(): SelectionBoundarySourceIdentity {
    this.#sealedIdentity = {
      bytes: this.#sourceBytes,
      sha256: this.#sourceHash.digest("hex"),
      recordCount: this.#recordCount
    };
    return this.#sealedIdentity;
  }
}

function encodeQuestionRecords(
  questionId: string,
  boundaries: readonly FineAssessmentSelectionBoundaryCase[]
): Buffer {
  const text = boundaries.map((boundary, invocationIndex) => JSON.stringify({
    question_id: questionId,
    invocation_index: invocationIndex,
    authoritative: invocationIndex === boundaries.length - 1,
    boundary
  } satisfies SelectionBoundaryRecord)).join("\n") + (boundaries.length === 0 ? "" : "\n");
  return Buffer.from(text, "utf8");
}

function assertRecordSequence(
  record: SelectionBoundaryRecord,
  previous: SelectionBoundaryRecord | undefined
): void {
  const exactKeys = Object.keys(record).sort().join(",") ===
    "authoritative,boundary,invocation_index,question_id";
  const beginsQuestion = previous === undefined ||
    previous.question_id !== record.question_id;
  const validIndex = beginsQuestion
    ? record.invocation_index === 0
    : record.invocation_index === previous.invocation_index + 1;
  const closedPrevious = previous === undefined ||
    !beginsQuestion || previous.authoritative;
  if (!exactKeys || typeof record.question_id !== "string" ||
      record.question_id.length === 0 ||
      !Number.isSafeInteger(record.invocation_index) ||
      typeof record.authoritative !== "boolean" ||
      !validIndex || !closedPrevious ||
      (!beginsQuestion && previous?.authoritative === true)) {
    throw new Error("selection replay record sequence is invalid");
  }
}

class SourceIdentityMeter extends Transform {
  readonly #hash = createHash("sha256");
  #bytes = 0;
  #recordCount = 0;

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void
  ): void {
    this.#hash.update(chunk);
    this.#bytes += chunk.byteLength;
    for (const byte of chunk) {
      if (byte === 0x0a) this.#recordCount += 1;
    }
    callback(null, chunk);
  }

  identity(): SelectionBoundarySourceIdentity {
    return {
      bytes: this.#bytes,
      sha256: this.#hash.digest("hex"),
      recordCount: this.#recordCount
    };
  }
}

function assertSourceIdentity(
  expected: SelectionBoundarySourceIdentity,
  actual: SelectionBoundarySourceIdentity
): void {
  if (actual.bytes !== expected.bytes ||
      actual.sha256 !== expected.sha256 ||
      actual.recordCount !== expected.recordCount) {
    throw new Error("selection replay source identity mismatch");
  }
}

function assertVerifiedRecordCount(
  expected: SelectionBoundarySourceIdentity,
  actualRecordCount: number
): void {
  if (actualRecordCount !== expected.recordCount) {
    throw new Error("selection replay verified record count mismatch");
  }
}

function formatByteLimit(maxBytes: number): string {
  const mebibyte = 1024 * 1024;
  return maxBytes % mebibyte === 0
    ? `${maxBytes / mebibyte} MiB`
    : `${maxBytes} ${maxBytes === 1 ? "byte" : "bytes"}`;
}
