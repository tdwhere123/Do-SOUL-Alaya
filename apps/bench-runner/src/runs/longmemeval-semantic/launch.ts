import { readBoundedCanonicalUtf8Artifact } from "../extraction/cache-audit/bounded-artifact-reader.js";
import { freezeLongMemEvalSemanticDevelopment } from "./freeze.js";
import { prepareLongMemEvalSemanticDevelopment, replayLongMemEvalSemanticDevelopment } from "./execute.js";
import { measureLongMemEvalSemanticDevelopment } from "./measure.js";

/** Bounded development orchestration only. The existing paid fill lane owns any provider execution. */
export async function runLongMemEvalSemanticLauncher(args: readonly string[]): Promise<number> {
  try {
    const [operation, ...rest] = args;
    const flags = new Map<string, string>();
    for (let index = 0; index < rest.length; index += 2) {
      const key = rest[index]!, value = rest[index + 1];
      if (!["--root", "--config", "--prepared", "--replay"].includes(key) || flags.has(key) || value === undefined) {
        throw new Error("invalid LongMemEval semantic arguments");
      }
      flags.set(key, value);
    }
    const required = (key: string) => { const value = flags.get(key); if (!value) throw new Error(`${key} is required`); return value; };
    const root = required("--root");
    let result: unknown;
    if (operation === "freeze") result = await freezeLongMemEvalSemanticDevelopment(JSON.parse(readBoundedCanonicalUtf8Artifact({
      path: required("--config"), maxBytes: 1024 * 1024, label: "LongMemEval semantic config" })), root);
    else if (operation === "prepare") result = await prepareLongMemEvalSemanticDevelopment(root);
    else if (operation === "replay") result = await replayLongMemEvalSemanticDevelopment(root, required("--prepared"));
    else if (operation === "measure") result = await measureLongMemEvalSemanticDevelopment(root, required("--replay"));
    else throw new Error("expected freeze, prepare, replay, or measure");
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); return 0;
  } catch (error) {
    process.stderr.write(`longmemeval semantic: ${error instanceof Error ? error.message : String(error)}\n`); return 2;
  }
}

const entry = process.argv[1]?.replaceAll("\\", "/");
if (entry?.endsWith("/longmemeval-semantic/launch.ts") || entry?.endsWith("/longmemeval-semantic/launch.js")) {
  void runLongMemEvalSemanticLauncher(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
