import { mkdir, open, readFile, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import {
  boundLifecycleFailure,
  renderLifecycleFailure,
  type BoundedLifecycleFailure
} from "../lifecycle/errors.js";

type ProcessMemoryUsage = Pick<
  NodeJS.MemoryUsage,
  "rss" | "heapTotal" | "heapUsed" | "external" | "arrayBuffers"
>;

export interface RecallEvalMemoryProfileOptions {
  readonly outputPath: string | undefined;
  readonly memoryUsage?: () => ProcessMemoryUsage;
  readonly readSmapsRollup?: () => Promise<string | null>;
  readonly monotonicNowMs?: () => number;
  readonly flushAndClose?: (file: FileHandle) => Promise<void>;
}

export interface RecallEvalMemorySampleInput {
  readonly phase: string;
  readonly questionId?: string;
  readonly questionIndex?: number;
}

export interface RecallEvalMemoryProfile {
  sample(input: RecallEvalMemorySampleInput): Promise<void>;
  markIncomplete(phase: string, error: unknown): BoundedLifecycleFailure;
  completion(): RecallEvalMemoryProfileCompletion;
  close(): Promise<void>;
}

export type RecallEvalMemoryProfileCompletion = Readonly<{
  status: "disabled" | "complete" | "incomplete";
  failures: readonly BoundedLifecycleFailure[];
}>;

export interface RecallEvalMemoryProfileRun<T> {
  readonly value: T;
  readonly completion: RecallEvalMemoryProfileCompletion;
}

interface RecallEvalMemoryProfileDependencies {
  readonly memoryUsage: () => ProcessMemoryUsage;
  readonly readSmapsRollup: () => Promise<string | null>;
  readonly monotonicNowMs: () => number;
  readonly flushAndClose: (file: FileHandle) => Promise<void>;
}

export async function createRecallEvalMemoryProfile(
  options: RecallEvalMemoryProfileOptions
): Promise<RecallEvalMemoryProfile | null> {
  if (options.outputPath === undefined) return null;
  if (options.outputPath.trim().length === 0) {
    throw new Error("recall-eval memory profile path must not be empty");
  }
  await mkdir(dirname(options.outputPath), { recursive: true });
  const file = await open(options.outputPath, "wx", 0o600);
  return new FileBackedRecallEvalMemoryProfile(file, {
    memoryUsage: options.memoryUsage ?? process.memoryUsage,
    readSmapsRollup: options.readSmapsRollup ?? readLinuxSmapsRollup,
    monotonicNowMs: options.monotonicNowMs ?? (() => performance.now()),
    flushAndClose: options.flushAndClose ?? syncAndClose
  });
}

export async function withRecallEvalMemoryProfile<T>(
  options: RecallEvalMemoryProfileOptions,
  run: (profile: RecallEvalMemoryProfile | null) => Promise<T>,
  warn: (message: string) => void = (message) => process.stderr.write(`${message}\n`)
): Promise<RecallEvalMemoryProfileRun<T>> {
  const profile = await createRecallEvalMemoryProfile(options);
  let result: T | undefined;
  let primaryError: unknown;
  try {
    result = await run(profile);
  } catch (error) {
    primaryError = error;
  }
  let closeError: unknown;
  try {
    await profile?.close();
  } catch (error) {
    closeError = error;
  }
  if (primaryError !== undefined && closeError !== undefined) {
    throw new AggregateError(
      [primaryError, closeError],
      "recall-eval memory profile lifecycle failed"
    );
  }
  if (primaryError !== undefined) throw primaryError;
  if (closeError !== undefined && profile !== null) {
    const failure = profile.markIncomplete("profile_close", closeError);
    warn(`[recall-eval memory-profile] incomplete ${renderLifecycleFailure(failure)}`);
  }
  return {
    value: result as T,
    completion: profile?.completion() ?? { status: "disabled", failures: [] }
  };
}

class FileBackedRecallEvalMemoryProfile implements RecallEvalMemoryProfile {
  readonly #file: FileHandle;
  readonly #dependencies: RecallEvalMemoryProfileDependencies;
  readonly #startedAtMs: number;
  readonly #failures: BoundedLifecycleFailure[] = [];
  #closed = false;
  #sequence = 0;

  constructor(
    file: FileHandle,
    dependencies: RecallEvalMemoryProfileDependencies
  ) {
    this.#file = file;
    this.#dependencies = dependencies;
    this.#startedAtMs = dependencies.monotonicNowMs();
  }

  async sample(input: RecallEvalMemorySampleInput): Promise<void> {
    this.#assertOpen();
    const usage = this.#dependencies.memoryUsage();
    const smaps = parseSmapsRollup(await this.#dependencies.readSmapsRollup());
    this.#sequence += 1;
    const sample = {
      schema_version: 1,
      sequence: this.#sequence,
      phase: input.phase,
      ...(input.questionId === undefined ? {} : { question_id: input.questionId }),
      ...(input.questionIndex === undefined ? {} : { question_index: input.questionIndex }),
      elapsed_ms: this.#dependencies.monotonicNowMs() - this.#startedAtMs,
      process_memory_usage_bytes: {
        rss: usage.rss,
        heap_total: usage.heapTotal,
        heap_used: usage.heapUsed,
        external: usage.external,
        array_buffers: usage.arrayBuffers
      },
      linux_smaps_rollup_kib: smaps
    };
    await this.#file.writeFile(`${JSON.stringify(sample)}\n`, "utf8");
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#dependencies.flushAndClose(this.#file);
  }

  markIncomplete(phase: string, error: unknown): BoundedLifecycleFailure {
    const failure = boundLifecycleFailure(phase, error);
    if (this.#failures.length < 8) this.#failures.push(failure);
    return failure;
  }

  completion(): RecallEvalMemoryProfileCompletion {
    return Object.freeze({
      status: this.#failures.length === 0 ? "complete" : "incomplete",
      failures: Object.freeze([...this.#failures])
    });
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("recall-eval memory profile is closed");
  }
}

async function syncAndClose(file: FileHandle): Promise<void> {
  let syncError: unknown;
  try {
    await file.sync();
  } catch (error) {
    syncError = error;
  }
  let closeError: unknown;
  try {
    await file.close();
  } catch (error) {
    closeError = error;
  }
  if (syncError !== undefined && closeError !== undefined) {
    throw new AggregateError([syncError, closeError], "memory profile close failed");
  }
  if (syncError !== undefined) throw syncError;
  if (closeError !== undefined) throw closeError;
}

async function readLinuxSmapsRollup(): Promise<string | null> {
  try {
    return await readFile("/proc/self/smaps_rollup", "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EACCES" || code === "EPERM") return null;
    throw error;
  }
}

function parseSmapsRollup(contents: string | null) {
  if (contents === null) return null;
  const values = new Map<string, number>();
  for (const line of contents.split("\n")) {
    const match = /^([A-Za-z_]+):\s+(\d+)\s+kB$/u.exec(line);
    if (match === null) continue;
    values.set(match[1] as string, Number.parseInt(match[2] as string, 10));
  }
  const required = [
    "Rss", "Pss", "Shared_Clean", "Shared_Dirty",
    "Private_Clean", "Private_Dirty", "Swap"
  ] as const;
  if (required.some((key) => values.get(key) === undefined)) return null;
  return {
    rss: values.get("Rss") as number,
    pss: values.get("Pss") as number,
    shared_clean: values.get("Shared_Clean") as number,
    shared_dirty: values.get("Shared_Dirty") as number,
    private_clean: values.get("Private_Clean") as number,
    private_dirty: values.get("Private_Dirty") as number,
    swap: values.get("Swap") as number
  };
}
