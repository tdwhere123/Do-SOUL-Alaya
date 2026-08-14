import process from "node:process";
import { publishExclusiveOutput } from "../output/exclusive-output.js";
import { retrofitObjectKeysOnSnapshot } from "./run.js";

interface RetrofitCommandOptions {
  readonly snapshot: string;
  readonly output?: string;
}

export async function runRetrofitObjectKeysCommand(
  args: readonly string[]
): Promise<number> {
  try {
    const options = parseRetrofitCommandOptions(args);
    const report = retrofitObjectKeysOnSnapshot(options.snapshot);
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (options.output !== undefined) {
      await publishExclusiveOutput(options.output, serialized);
    }
    process.stdout.write(serialized);
    return 0;
  } catch (error) {
    process.stderr.write(
      `alaya-bench-runner retrofit-object-keys: ${errorMessage(error)}\n`
    );
    return 2;
  }
}

function parseRetrofitCommandOptions(args: readonly string[]): RetrofitCommandOptions {
  let snapshot: string | undefined;
  let output: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--snapshot") {
      if (snapshot !== undefined) throw new Error("duplicate --snapshot");
      snapshot = readValue(args, ++index, "--snapshot");
    } else if (token === "--output") {
      if (output !== undefined) throw new Error("duplicate --output");
      output = readValue(args, ++index, "--output");
    } else {
      throw new Error(`unknown argument '${token ?? ""}'`);
    }
  }
  if (snapshot === undefined) throw new Error("--snapshot <db> required");
  return { snapshot, ...(output === undefined ? {} : { output }) };
}

function readValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index];
  if (value === undefined || value.length === 0 || value.startsWith("--")) {
    throw new Error(`${flag} requires a path value`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
