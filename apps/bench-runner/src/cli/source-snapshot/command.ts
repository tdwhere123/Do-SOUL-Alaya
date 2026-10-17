import { execFileSync } from "node:child_process";
import { AlayaError } from "@do-soul/alaya-protocol";
import { fileURLToPath } from "node:url";
import { loadDatasetWindowWithIdentity } from "../../datasets/longmemeval/ingestion/fetch.js";
import { buildLongMemEvalQueryInput, createLongMemEvalTaskPersonaPolicy,
  LongMemEvalTaskPersonaPolicySchema } from "../../datasets/longmemeval/ingestion/task-persona.js";
import { prepareSourceRecordsSnapshot } from "../../runs/snapshot/source-records/prepare.js";
import { inspectSourceRecordsSnapshot } from "../../runs/snapshot/source-records/inspect.js";
import { matchFlagToken, nextIndex, readRequiredFlagValue } from "../options/flag-values.js";

type Operation = "prepare" | "inspect" | "query-input";
export async function runSourceSnapshotCommand(args: readonly string[]): Promise<number> {
  try {
    const [operation, ...rest] = args;
    if (operation !== "prepare" && operation !== "inspect" && operation !== "query-input") {
      throw new Error("source-snapshot requires prepare, inspect or query-input");
    }
    const flags = parseFlags(rest, operation);
    const result = operation === "query-input" ? await prepareQueryInput(flags) : operation === "prepare"
      ? await prepareSourceRecordsSnapshot({ snapshotPath: required(flags, "--snapshot"),
        dataDirRoot: required(flags, "--data-dir-root"),
        dataDir: flags.get("--data-dir"), pinnedMetaRoot: flags.get("--pinned-meta-root"),
        offset: integer(flags.get("--offset") ?? "0", 0), limit: integer(required(flags, "--limit"), 1),
        recordedAt: required(flags, "--recorded-at"),
        ...(flags.has("--attribution-policy") ? { personaSuccessor: {
          policy: LongMemEvalTaskPersonaPolicySchema.parse(required(flags, "--attribution-policy")),
          parentSnapshotPath: required(flags, "--parent-snapshot")
        } } : {}),
        producerCommit: flags.get("--producer-commit") ?? execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: fileURLToPath(new URL("../../../../../", import.meta.url)), encoding: "utf8"
        }).trim() })
      : await inspectSourceRecordsSnapshot({ snapshotPath: required(flags, "--snapshot"),
        questionId: required(flags, "--question-id"), query: required(flags, "--query"),
        maxResults: integer(flags.get("--max-results") ?? "20", 1),
        maxPages: integer(flags.get("--max-pages") ?? "100", 1) });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`alaya-bench-runner source-snapshot: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

async function prepareQueryInput(flags: ReadonlyMap<string, string>) {
  const loaded = await loadDatasetWindowWithIdentity("longmemeval_s", {
    dataDir: flags.get("--data-dir"), pinnedMetaRoot: flags.get("--pinned-meta-root"),
    offset: integer(flags.get("--offset") ?? "0", 0), limit: 1
  });
  const question = loaded.questions[0];
  if (question === undefined || question.question_id !== required(flags, "--question-id")) {
    throw new AlayaError("CONFLICT", "query input question differs from the original dataset window");
  }
  if (flags.has("--attribution-policy")) {
    LongMemEvalTaskPersonaPolicySchema.parse(required(flags, "--attribution-policy"));
    return buildLongMemEvalQueryInput(question, { persona: createLongMemEvalTaskPersonaPolicy(loaded) });
  }
  return buildLongMemEvalQueryInput(question);
}

function parseFlags(args: readonly string[], operation: Operation): Map<string, string> {
  const allowed = operation === "prepare"
    ? ["--snapshot", "--data-dir-root", "--data-dir", "--pinned-meta-root", "--offset", "--limit", "--recorded-at",
      "--producer-commit", "--attribution-policy", "--parent-snapshot"]
    : operation === "query-input"
      ? ["--data-dir", "--pinned-meta-root", "--offset", "--question-id", "--attribution-policy"]
      : ["--snapshot", "--question-id", "--query", "--max-results", "--max-pages"];
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const token = args[index]!;
    const flag = allowed.find((candidate) => matchFlagToken(token, candidate));
    if (flag === undefined || flags.has(flag)) throw new Error(`unknown or repeated source-snapshot flag '${token}'`);
    flags.set(flag, readRequiredFlagValue(args, index, token, flag, `${flag} requires a value`));
    index = nextIndex(index, token);
  }
  if (flags.has("--parent-snapshot") && !flags.has("--attribution-policy")) {
    throw new AlayaError("VALIDATION", "--parent-snapshot requires explicit --attribution-policy");
  }
  return flags;
}

function required(flags: ReadonlyMap<string, string>, name: string): string {
  const value = flags.get(name);
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function integer(value: string, minimum: number): number {
  const parsed = Number(value);
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`invalid integer '${value}'`);
  return parsed;
}
