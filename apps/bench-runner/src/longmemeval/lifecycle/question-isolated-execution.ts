import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { throwLifecycleErrors } from "./errors.js";
import { finalizeOwnedTempRoot } from "./owned-temp-root.js";

export interface IsolatedQuestionRoot {
  readonly path: string;
  readonly owned: true;
}

export interface IsolatedQuestionSequenceInput<Question, Daemon, Result, Inventory, Aggregate> {
  readonly questions: readonly Question[];
  readonly rootParent?: string;
  readonly rootPrefix: string;
  readonly initialAggregate: Aggregate;
  readonly mergeAggregate: (aggregate: Aggregate, inventory: Inventory) => Aggregate;
  readonly start: (
    root: IsolatedQuestionRoot,
    question: Question,
    index: number
  ) => Promise<Daemon>;
  readonly run: (
    daemon: Daemon,
    question: Question,
    index: number
  ) => Promise<Result>;
  readonly collect: (
    daemon: Daemon,
    question: Question,
    index: number
  ) => Promise<Inventory>;
  readonly shutdown: (daemon: Daemon) => Promise<void>;
  readonly isSuccessful?: (result: Result, question: Question, index: number) => boolean;
  readonly failureLabel?: (question: Question, index: number) => string;
}

export interface IsolatedQuestionSequenceResult<Result, Aggregate> {
  readonly results: readonly Result[];
  readonly aggregate: Aggregate;
}

export async function runIsolatedQuestionSequence<
  Question,
  Daemon,
  Result,
  Inventory,
  Aggregate
>(
  input: IsolatedQuestionSequenceInput<Question, Daemon, Result, Inventory, Aggregate>
): Promise<IsolatedQuestionSequenceResult<Result, Aggregate>> {
  const results: Result[] = [];
  let aggregate = input.initialAggregate;
  for (let index = 0; index < input.questions.length; index += 1) {
    const question = input.questions[index];
    if (question === undefined) continue;
    const root = await createQuestionRoot(input.rootParent, input.rootPrefix);
    const output = await runOneQuestion(input, root, question, index);
    results.push(output.result);
    aggregate = input.mergeAggregate(aggregate, output.inventory);
  }
  return { results, aggregate };
}

async function runOneQuestion<Question, Daemon, Result, Inventory, Aggregate>(
  input: IsolatedQuestionSequenceInput<Question, Daemon, Result, Inventory, Aggregate>,
  root: IsolatedQuestionRoot,
  question: Question,
  index: number
): Promise<{ readonly result: Result; readonly inventory: Inventory }> {
  let daemon: Daemon | undefined;
  let result: Result | undefined;
  let inventory: Inventory | undefined;
  let completed = false;
  let primaryError: unknown;
  try {
    daemon = await input.start(root, question, index);
    result = await input.run(daemon, question, index);
    inventory = await input.collect(daemon, question, index);
    completed = true;
  } catch (error) {
    primaryError = error;
  }
  const shutdownError = await captureShutdownError(input, daemon);
  const succeeded = completed && primaryError === undefined && shutdownError === undefined &&
    (input.isSuccessful?.(result as Result, question, index) ?? true);
  const cleanupError = await captureCleanupError(
    root,
    succeeded,
    input.failureLabel?.(question, index)
  );
  throwLifecycleErrors("LongMemEval question lifecycle failed", [
    primaryError,
    shutdownError,
    cleanupError
  ]);
  if (!completed) throw new Error("LongMemEval question produced no result");
  return { result: result as Result, inventory: inventory as Inventory };
}

async function captureShutdownError<Daemon>(
  input: Pick<IsolatedQuestionSequenceInput<unknown, Daemon, unknown, unknown, unknown>, "shutdown">,
  daemon: Daemon | undefined
): Promise<unknown> {
  try {
    if (daemon !== undefined) await input.shutdown(daemon);
    return undefined;
  } catch (error) {
    return error;
  }
}

async function captureCleanupError(
  root: IsolatedQuestionRoot,
  succeeded: boolean,
  failureLabel: string | undefined
): Promise<unknown> {
  try {
    await finalizeOwnedTempRoot(root, succeeded);
    if (!succeeded && failureLabel !== undefined) {
      await writeFile(join(root.path, "FAILED_QUESTION.txt"), `${failureLabel}\n`, "utf8");
    }
    return undefined;
  } catch (error) {
    return error;
  }
}

async function createQuestionRoot(
  requestedParent: string | undefined,
  prefix: string
): Promise<IsolatedQuestionRoot> {
  if (prefix.length === 0 || basename(prefix) !== prefix) {
    throw new Error("question root prefix must be a non-empty basename");
  }
  const parent = requestedParent ?? tmpdir();
  await mkdir(parent, { recursive: true });
  return { path: await mkdtemp(join(parent, prefix)), owned: true };
}
