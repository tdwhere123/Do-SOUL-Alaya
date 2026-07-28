import { randomUUID } from "node:crypto";
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
import { createInterface } from "node:readline";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import {
  replayFineAssessmentSelectionBoundary,
  type FineAssessmentSelectionBoundaryCase
} from "@do-soul/alaya-core";

export const LONGMEMEVAL_SELECTION_BOUNDARY_GZIP_MAX_BYTES =
  64 * 1024 * 1024;
export const LONGMEMEVAL_SELECTION_REPLAY_ENV =
  "ALAYA_BENCH_SELECTION_REPLAY";

export interface LongMemEvalSelectionBoundaryQuestionCapture {
  readonly observer: (
    boundary: FineAssessmentSelectionBoundaryCase
  ) => undefined;
  commit(): Promise<void>;
}

export interface LongMemEvalSelectionBoundarySpool {
  readonly rootPath: string;
  beginQuestion(questionId: string): LongMemEvalSelectionBoundaryQuestionCapture;
  writeGzipArtifact(artifactPath: string): Promise<{ readonly recordCount: number }>;
  dispose(): Promise<void>;
}

type SelectionBoundaryRecord = Readonly<{
  readonly question_id: string;
  readonly invocation_index: number;
  readonly authoritative: boolean;
  readonly boundary: FineAssessmentSelectionBoundaryCase;
}>;

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
  artifactPath: string
): Promise<{ readonly recordCount: number }> {
  return verifyRecordStream(createReadStream(artifactPath).pipe(createGunzip()));
}

class SelectionBoundarySpool implements LongMemEvalSelectionBoundarySpool {
  readonly #spoolPath: string;
  #disposed = false;
  #sealed = false;
  #recordCount = 0;

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
    const boundaries: FineAssessmentSelectionBoundaryCase[] = [];
    let committed = false;
    return Object.freeze({
      observer: (boundary: FineAssessmentSelectionBoundaryCase) => {
        if (committed) throw new Error("selection replay question is committed");
        boundaries.push(boundary);
        return undefined;
      },
      commit: async () => {
        if (committed) throw new Error("selection replay question is committed");
        committed = true;
        this.#assertWritable();
        if (boundaries.length === 0) {
          throw new Error("selection replay captured no selection invocation");
        }
        await appendFile(
          this.#spoolPath,
          encodeQuestionRecords(questionId, boundaries),
          "utf8"
        );
        this.#recordCount += boundaries.length;
      }
    });
  }

  async writeGzipArtifact(
    artifactPath: string
  ): Promise<{ readonly recordCount: number }> {
    this.#assertWritable();
    this.#sealed = true;
    await mkdir(dirname(artifactPath), { recursive: true });
    const partialPath = `${artifactPath}.partial-${randomUUID()}`;
    try {
      await pipeline(
        createReadStream(this.#spoolPath),
        createGzip(),
        compressedSizeLimit(this.maxArtifactBytes),
        createWriteStream(partialPath, { flags: "wx" })
      );
      await rename(partialPath, artifactPath);
      return { recordCount: this.#recordCount };
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
    if (this.#sealed) throw new Error("selection replay spool is sealed");
  }
}

function encodeQuestionRecords(
  questionId: string,
  boundaries: readonly FineAssessmentSelectionBoundaryCase[]
): string {
  return boundaries.map((boundary, invocationIndex) => JSON.stringify({
    question_id: questionId,
    invocation_index: invocationIndex,
    authoritative: invocationIndex === boundaries.length - 1,
    boundary
  } satisfies SelectionBoundaryRecord)).join("\n") + (boundaries.length === 0 ? "" : "\n");
}

async function verifyRecordStream(
  stream: NodeJS.ReadableStream
): Promise<{ readonly recordCount: number }> {
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let recordCount = 0;
  let previous: SelectionBoundaryRecord | undefined;
  for await (const line of lines) {
    if (line.length === 0) continue;
    const record = JSON.parse(line) as SelectionBoundaryRecord;
    assertRecordSequence(record, previous);
    replayFineAssessmentSelectionBoundary(record.boundary);
    previous = record;
    recordCount += 1;
  }
  if (previous !== undefined && !previous.authoritative) {
    throw new Error("selection replay question has no authoritative invocation");
  }
  return { recordCount };
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

function compressedSizeLimit(maxBytes: number): Transform {
  let compressedBytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      compressedBytes += chunk.byteLength;
      if (compressedBytes > maxBytes) {
        callback(new Error(
          "selection replay gzip exceeds the 64 MiB size limit"
        ));
        return;
      }
      callback(null, chunk);
    }
  });
}
