import { AlayaError } from "@do-soul/alaya-protocol";
import { z } from "zod";
import { prepareSemanticChain } from "./prepare.js";
import { replaySemanticChain, measureSemanticChain } from "./replay.js";
import { readBoundedCanonicalUtf8Artifact } from "../extraction/cache-audit/bounded-artifact-reader.js";
import { admitEvaluatorOutputRoot } from "../measurement/evaluator-output.js";

/** Private measurement entry; source-prepare explicitly invokes the existing local Source producer. */
export async function runRecallMeasurementLauncher(args: readonly string[]): Promise<number> {
  try {
    const [operation, ...rest] = args;
    const flags = new Map<string, string>();
    for (let index = 0; index < rest.length; index += 2) {
      const key = rest[index]!, value = rest[index + 1];
      if (!["--root", "--config", "--execution", "--replay", "--gold", "--evaluator-root", "--arm"].includes(key) ||
          flags.has(key) || value === undefined) throw new AlayaError("VALIDATION", "invalid recall measurement arguments");
      flags.set(key, value);
    }
    const required = (key: string) => {
      const value = flags.get(key);
      if (!value) throw new AlayaError("VALIDATION", `${key} is required`);
      return value;
    };
    const json = (path: string): unknown => JSON.parse(readBoundedCanonicalUtf8Artifact({
      path, maxBytes: 32 * 1024 * 1024, label: "semantic chain input" }));
    let result: unknown, code = 0;
    if (operation === "source-prepare") {
      const prepared = await (await import("./source-index-binding.js"))
        .prepareSemanticChainSourceIndex(json(required("--config")), json(required("--execution")), required("--root"));
      result = prepared;
      if (prepared.config === null) code = 2;
    } else if (operation === "prepare") result = await prepareSemanticChain(json(required("--config")), required("--root"));
    else if (operation === "replay") result = await replaySemanticChain(required("--root"),
      z.enum(["retained", "without_semantic_correspondences"]).parse(flags.get("--arm") ?? "retained"));
    else if (operation === "measure") {
      const root = required("--root"), replayPath = required("--replay"), goldPath = required("--gold");
      const outputRoot = admitEvaluatorOutputRoot(required("--evaluator-root"), [root, replayPath, goldPath]);
      result = measureSemanticChain(root, replayPath, json(goldPath), outputRoot);
    } else throw new AlayaError("VALIDATION", "unknown recall measurement operation");
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return code;
  } catch (error) {
    process.stderr.write(`recall measurement: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

const entry = process.argv[1]?.replaceAll("\\", "/");
if (entry?.endsWith("/recall-measurement/launch.ts") || entry?.endsWith("/recall-measurement/launch.js")) {
  void runRecallMeasurementLauncher(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
