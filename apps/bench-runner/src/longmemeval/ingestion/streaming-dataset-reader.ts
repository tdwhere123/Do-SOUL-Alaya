import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { TextDecoder } from "node:util";
import {
  LongMemEvalQuestionSchema,
  type LongMemEvalQuestion
} from "./dataset.js";

export interface StreamedLongMemEvalDatasetIdentity {
  readonly sha256: string;
  readonly bytesRead: number;
  readonly questionCount: number;
  readonly parseError?: Error;
}

export interface StreamLongMemEvalDatasetLimits {
  readonly datasetLabel: string;
  readonly expectedBytes: number;
  readonly maxQuestionCount: number;
}

const MAX_QUESTION_BYTES = 4 * 1024 * 1024;
const MAX_JSON_NESTING = 64;

export async function streamLongMemEvalDataset(
  sourcePath: string,
  limits: StreamLongMemEvalDatasetLimits,
  onQuestion: (question: LongMemEvalQuestion, index: number) => void
): Promise<StreamedLongMemEvalDatasetIdentity> {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(
    sourcePath,
    constants.O_RDONLY | constants.O_NONBLOCK | noFollow
  );
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) throw new Error("LongMemEval dataset is not a regular file");
    if (fileStat.size !== limits.expectedBytes) {
      throw pinnedByteMismatch(limits, fileStat.size);
    }
    return await streamOpenedDataset(handle, limits, onQuestion);
  } finally {
    await handle.close();
  }
}

async function streamOpenedDataset(
  handle: FileHandle,
  limits: StreamLongMemEvalDatasetLimits,
  onQuestion: (question: LongMemEvalQuestion, index: number) => void
): Promise<StreamedLongMemEvalDatasetIdentity> {
  const hash = createHash("sha256");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const reader = new TopLevelQuestionArrayReader(limits.maxQuestionCount, onQuestion);
  let parseError: Error | undefined;
  let bytesRead = 0;
  const stream = handle.createReadStream({ autoClose: false });
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytesRead += bytes.byteLength;
    if (bytesRead > limits.expectedBytes) {
      throw pinnedByteMismatch(limits, bytesRead);
    }
    hash.update(bytes);
    if (parseError !== undefined) continue;
    try {
      reader.consume(decoder.decode(bytes, { stream: true }));
    } catch (error) {
      parseError = toError(error);
    }
  }
  if (parseError === undefined) {
    try {
      reader.consume(decoder.decode());
      reader.finish();
    } catch (error) {
      parseError = toError(error);
    }
  }
  return {
    sha256: hash.digest("hex"),
    bytesRead,
    questionCount: reader.questionCount,
    ...(parseError === undefined ? {} : { parseError })
  };
}

function pinnedByteMismatch(
  limits: StreamLongMemEvalDatasetLimits,
  actualBytes: number
): Error {
  return new Error(
    `dataset checksum mismatch: ${limits.datasetLabel}; ` +
    `pinned_size=${limits.expectedBytes}; actual_size=${actualBytes}`
  );
}

type ReaderPhase =
  | "array_start"
  | "first_value_or_end"
  | "value"
  | "comma_or_end"
  | "next_value"
  | "done";

class TopLevelQuestionArrayReader {
  #phase: ReaderPhase = "array_start";
  #parts: string[] = [];
  #partBytes = 0;
  #closers: string[] = [];
  #inString = false;
  #escaped = false;
  #questionCount = 0;

  constructor(
    private readonly maxQuestionCount: number,
    private readonly onQuestion: (question: LongMemEvalQuestion, index: number) => void
  ) {}

  get questionCount(): number {
    return this.#questionCount;
  }

  consume(chunk: string): void {
    let captureStart = this.#phase === "value" ? 0 : -1;
    for (let index = 0; index < chunk.length; index += 1) {
      const character = chunk[index]!;
      if (this.#phase === "value") {
        if (this.#consumeValueCharacter(character)) {
          this.#appendPart(chunk.slice(captureStart, index + 1));
          this.#finishValue();
          captureStart = -1;
        }
        continue;
      }
      const started = this.#consumeBoundaryCharacter(character);
      if (started) captureStart = index;
    }
    if (captureStart >= 0) this.#appendPart(chunk.slice(captureStart));
  }

  finish(): number {
    if (this.#phase !== "done") {
      throw new Error("LongMemEval dataset is not a complete JSON array");
    }
    return this.#questionCount;
  }

  #consumeBoundaryCharacter(character: string): boolean {
    if (isJsonWhitespace(character)) return false;
    if (this.#phase === "array_start" && character === "[") {
      this.#phase = "first_value_or_end";
      return false;
    }
    if (this.#phase === "first_value_or_end" && character === "]") {
      this.#phase = "done";
      return false;
    }
    if ((this.#phase === "first_value_or_end" || this.#phase === "next_value") &&
        character === "{") {
      this.#startValue();
      return true;
    }
    if (this.#phase === "comma_or_end" && character === ",") {
      this.#phase = "next_value";
      return false;
    }
    if (this.#phase === "comma_or_end" && character === "]") {
      this.#phase = "done";
      return false;
    }
    throw new Error("LongMemEval dataset has invalid top-level JSON array syntax");
  }

  #startValue(): void {
    this.#phase = "value";
    this.#parts = [];
    this.#partBytes = 0;
    this.#closers = ["}"];
    this.#inString = false;
    this.#escaped = false;
  }

  #consumeValueCharacter(character: string): boolean {
    if (this.#inString) {
      if (this.#escaped) this.#escaped = false;
      else if (character === "\\") this.#escaped = true;
      else if (character === "\"") this.#inString = false;
      return false;
    }
    if (character === "\"") this.#inString = true;
    else if (character === "{") this.#pushCloser("}");
    else if (character === "[") this.#pushCloser("]");
    else if (character === "}" || character === "]") this.#closeValue(character);
    return this.#closers.length === 0;
  }

  #closeValue(character: string): void {
    if (this.#closers.pop() !== character) {
      throw new Error("LongMemEval dataset question has mismatched JSON delimiters");
    }
  }

  #pushCloser(closer: string): void {
    if (this.#closers.length >= MAX_JSON_NESTING) {
      throw new Error("LongMemEval dataset question exceeds JSON nesting limit");
    }
    this.#closers.push(closer);
  }

  #appendPart(part: string): void {
    this.#partBytes += Buffer.byteLength(part, "utf8");
    if (this.#partBytes > MAX_QUESTION_BYTES) {
      throw new Error("LongMemEval dataset question exceeds byte limit");
    }
    this.#parts.push(part);
  }

  #finishValue(): void {
    const index = this.#questionCount;
    if (index >= this.maxQuestionCount) {
      throw new Error("LongMemEval dataset exceeds pinned question count");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.#parts.join(""));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`invalid LongMemEval question[${index}] JSON: ${detail}`);
    }
    const question = LongMemEvalQuestionSchema.safeParse(parsed);
    if (!question.success) {
      const issues = question.error.issues.map((issue) =>
        `${issue.path.join(".")}: ${issue.message}`
      ).join("; ");
      throw new Error(`invalid LongMemEval question[${index}]: ${issues}`);
    }
    this.onQuestion(question.data, index);
    this.#questionCount += 1;
    this.#phase = "comma_or_end";
    this.#parts = [];
    this.#partBytes = 0;
  }
}

function isJsonWhitespace(character: string): boolean {
  return character === " " || character === "\n" ||
    character === "\r" || character === "\t";
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
