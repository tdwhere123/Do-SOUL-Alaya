import { AlayaError } from "@do-soul/alaya-protocol";
import { readBoundedCanonicalUtf8Artifact } from "../extraction/cache-audit/bounded-artifact-reader.js";
import { freezeLongMemEvalSemanticRun } from "./freeze.js";
import { prepareLongMemEvalSemanticRun, replayLongMemEvalSemanticRun } from "./execute.js";
import { measureLongMemEvalSemanticRun } from "./measure.js";
import { writeLongMemEvalLazyConfig } from "./lazy-config.js";
import { measureLongMemEvalLazyFirstExposure } from "./lazy-measure.js";
import { freezeLongMemEvalLazyPopulation, runLongMemEvalLazyPopulationStage } from "./population.js";
import { observeLongMemEvalLazyPopulation } from "./population-observation.js";

/** Frozen dataset orchestration. The existing paid fill lane owns any provider execution. */
export async function runLongMemEvalSemanticLauncher(args: readonly string[]): Promise<number> {
  try {
    const [operation, ...rest] = args;
    const flags = new Map<string, string>();
    for (let index = 0; index < rest.length; index += 2) {
      const key = rest[index]!, value = rest[index + 1];
      if (!["--root", "--config", "--prepared", "--replay", "--source-preflight", "--source-cache-root",
        "--lazy-root", "--evaluator-root", "--out", "--member", "--stage", "--source-cap"].includes(key) || flags.has(key) || value === undefined) {
        throw new AlayaError("VALIDATION", "invalid LongMemEval semantic arguments");
      }
      flags.set(key, value);
    }
    const required = (key: string) => { const value = flags.get(key); if (!value) throw new AlayaError("VALIDATION", `${key} is required`); return value; };
    const root = required("--root");
    const sourceScope = flags.has("--source-cap") ? { sourceRequestScope: {
      kind: "native_first_page" as const, source_cap: Number(flags.get("--source-cap")) } } : {};
    let result: unknown;
    if (operation === "freeze") result = await freezeLongMemEvalSemanticRun(JSON.parse(readBoundedCanonicalUtf8Artifact({
      path: required("--config"), maxBytes: 1024 * 1024, label: "LongMemEval semantic config" })), root);
    else if (operation === "prepare") result = await prepareLongMemEvalSemanticRun(root);
    else if (operation === "replay") result = await replayLongMemEvalSemanticRun(root, required("--prepared"));
    else if (operation === "measure") result = await measureLongMemEvalSemanticRun(root, required("--replay"), required("--evaluator-root"));
    else if (operation === "bind-lazy") result = await writeLongMemEvalLazyConfig({ root,
      preparedPath: required("--prepared"), sourcePreflightPath: required("--source-preflight"),
      sourceCacheRoot: required("--source-cache-root"), ...sourceScope }, required("--out"));
    else if (operation === "measure-lazy") result = await measureLongMemEvalLazyFirstExposure({ root,
      preparedPath: required("--prepared"), sourcePreflightPath: required("--source-preflight"),
      sourceCacheRoot: required("--source-cache-root"), ...sourceScope, lazyRoot: required("--lazy-root"),
      evaluatorRoot: required("--evaluator-root") });
    else if (operation === "freeze-population") result = freezeLongMemEvalLazyPopulation(JSON.parse(readBoundedCanonicalUtf8Artifact({
      path: required("--config"), maxBytes: 1024 * 1024, label: "LongMemEval population metadata" })), root);
    else if (operation === "run-population-stage") result = await runLongMemEvalLazyPopulationStage(root,
      required("--member"), required("--stage") as Parameters<typeof runLongMemEvalLazyPopulationStage>[2]);
    else if (operation === "observe-population") {
      const cutoffConfigPath = required("--config");
      result = await observeLongMemEvalLazyPopulation(root,
        JSON.parse(readBoundedCanonicalUtf8Artifact({ path: cutoffConfigPath, maxBytes: 1024 * 1024,
          label: "LongMemEval population cutoff" })), required("--evaluator-root"), cutoffConfigPath);
    }
    else throw new AlayaError("VALIDATION", "unknown LongMemEval semantic operation");
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); return 0;
  } catch (error) {
    process.stderr.write(`longmemeval semantic: ${error instanceof Error ? error.message : String(error)}\n`); return 2;
  }
}

const entry = process.argv[1]?.replaceAll("\\", "/");
if (entry?.endsWith("/longmemeval-semantic/launch.ts") || entry?.endsWith("/longmemeval-semantic/launch.js")) {
  void runLongMemEvalSemanticLauncher(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
