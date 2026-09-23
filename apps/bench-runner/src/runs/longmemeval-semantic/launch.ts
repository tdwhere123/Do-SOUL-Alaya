import { AlayaError } from "@do-soul/alaya-protocol";
import { readBoundedCanonicalUtf8Artifact } from "../extraction/cache-audit/bounded-artifact-reader.js";
import { freezeLongMemEvalSemanticRun } from "./freeze.js";
import { prepareLongMemEvalSemanticRun, replayLongMemEvalSemanticRun } from "./execute.js";
import { measureLongMemEvalSemanticRun } from "./measure.js";

/** Frozen dataset orchestration. The existing paid fill lane owns any provider execution. */
export async function runLongMemEvalSemanticLauncher(args: readonly string[]): Promise<number> {
  try {
    const [operation, ...rest] = args;
    const flags = new Map<string, string>();
    for (let index = 0; index < rest.length; index += 2) {
      const key = rest[index]!, value = rest[index + 1];
      if (!["--root", "--config", "--prepared", "--replay"].includes(key) || flags.has(key) || value === undefined) {
        throw new AlayaError("VALIDATION", "invalid LongMemEval semantic arguments");
      }
      flags.set(key, value);
    }
    const required = (key: string) => { const value = flags.get(key); if (!value) throw new AlayaError("VALIDATION", `${key} is required`); return value; };
    const root = required("--root");
    let result: unknown;
    if (operation === "freeze") result = await freezeLongMemEvalSemanticRun(JSON.parse(readBoundedCanonicalUtf8Artifact({
      path: required("--config"), maxBytes: 1024 * 1024, label: "LongMemEval semantic config" })), root);
    else if (operation === "prepare") result = await prepareLongMemEvalSemanticRun(root);
    else if (operation === "replay") result = await replayLongMemEvalSemanticRun(root, required("--prepared"));
    else if (operation === "measure") result = await measureLongMemEvalSemanticRun(root, required("--replay"));
    else throw new AlayaError("VALIDATION", "expected freeze, prepare, replay, or measure");
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); return 0;
  } catch (error) {
    process.stderr.write(`longmemeval semantic: ${error instanceof Error ? error.message : String(error)}\n`); return 2;
  }
}

const entry = process.argv[1]?.replaceAll("\\", "/");
if (entry?.endsWith("/longmemeval-semantic/launch.ts") || entry?.endsWith("/longmemeval-semantic/launch.js")) {
  void runLongMemEvalSemanticLauncher(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
