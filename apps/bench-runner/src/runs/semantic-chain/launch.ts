import { z } from "zod";
import { prepareSemanticChain } from "./prepare.js";
import { replaySemanticChain, measureSemanticChain } from "./replay.js";
import { prepareSourcePublicationAssociations } from "../snapshot/source-records/prepare-associations.js";
import { isExtractionRequestProfile } from "../extraction/request-profile.js";
import { readBoundedCanonicalUtf8Artifact } from "../extraction/cache-audit/bounded-artifact-reader.js";

/** Offline orchestration. Paid Q/A uses the existing semantic-proposal-fill entry and its explicit authority. */
export async function runSemanticChainLauncher(args: readonly string[]): Promise<number> {
  try {
    const [operation, ...rest] = args;
    const flags = new Map<string, string>();
    const allowed = new Set(["--root", "--config", "--replay", "--gold", "--arm", "--preflight", "--out"]);
    for (let index = 0; index < rest.length; index += 2) {
      const key = rest[index]!, value = rest[index + 1];
      if (!allowed.has(key) || flags.has(key) || value === undefined) throw new Error("invalid semantic chain arguments");
      flags.set(key, value);
    }
    const required = (key: string) => { const value = flags.get(key); if (!value) throw new Error(`${key} is required`); return value; };
    const json = (path: string): unknown => JSON.parse(readBoundedCanonicalUtf8Artifact({
      path, maxBytes: 32 * 1024 * 1024, label: "semantic chain input" }));
    let result: unknown;
    if (operation === "prepare") result = await prepareSemanticChain(json(required("--config")), required("--root"));
    else if (operation === "replay") result = await replaySemanticChain(required("--root"),
      z.enum(["retained", "without_alignments"]).parse(flags.get("--arm") ?? "retained"));
    else if (operation === "measure") result = measureSemanticChain(required("--root"), required("--replay"), json(required("--gold")));
    else if (operation === "associate") {
      const population = z.object({ name: z.string(), dataDir: z.string(), pinnedMetaRoot: z.string(),
        cacheRoot: z.string(), model: z.string(), requestProfile: z.string().refine(isExtractionRequestProfile)
      }).strict().parse(json(required("--config")));
      if (!isExtractionRequestProfile(population.requestProfile)) throw new Error("unsupported extraction request profile");
      result = await prepareSourcePublicationAssociations({ ...population, requestProfile: population.requestProfile },
        required("--preflight"), required("--out"));
    } else throw new Error("expected prepare, replay, measure, or associate");
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`semantic chain: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

const entry = process.argv[1]?.replaceAll("\\", "/");
if (entry?.endsWith("/semantic-chain/launch.ts") || entry?.endsWith("/semantic-chain/launch.js")) {
  void runSemanticChainLauncher(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
