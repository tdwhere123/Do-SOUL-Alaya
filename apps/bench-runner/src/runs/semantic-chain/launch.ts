import { AlayaError } from "@do-soul/alaya-protocol";
import { z } from "zod";
import { prepareSemanticChain } from "./prepare.js";
import { writeDirectLazyConfig } from "./bind-lazy.js";
import { replaySemanticChain, measureSemanticChain } from "./replay.js";
import { interveneSemanticChain } from "./intervene.js";
import { prepareSourcePublicationAssociations } from "../snapshot/source-records/prepare-associations.js";
import { isExtractionRequestProfile } from "../extraction/request-profile.js";
import { readBoundedCanonicalUtf8Artifact } from "../extraction/cache-audit/bounded-artifact-reader.js";
import { SourceRecordsDatasetSchema } from "../snapshot/source-records/contract.js";
import { parseExtractionOpenSemanticsGeneration } from "../extraction/request-artifact.js";
import { prepareLazyQualificationWindow, sealLazyQualificationFinal,
  replayLazyQualifiedFirstExposure } from "./lazy-qualification.js";

/** Offline orchestration. Paid query semantics and semantic correspondence uses the existing semantic-proposal-fill entry and its explicit authority. */
export async function runSemanticChainLauncher(args: readonly string[]): Promise<number> {
  try {
    const [operation, ...rest] = args;
    const flags = new Map<string, string>();
    const allowed = new Set(["--root", "--config", "--replay", "--gold", "--arm", "--out", "--leaf-trials",
      "--population", "--source-preflight", "--source-cache-root", "--recorded-at", "--producer-commit"]);
    for (let index = 0; index < rest.length; index += 2) {
      const key = rest[index]!, value = rest[index + 1];
      if (!allowed.has(key) || flags.has(key) || value === undefined) throw new AlayaError("VALIDATION", "invalid semantic chain arguments");
      flags.set(key, value);
    }
    const required = (key: string) => { const value = flags.get(key); if (!value) throw new AlayaError("VALIDATION", `${key} is required`); return value; };
    const json = (path: string): unknown => JSON.parse(readBoundedCanonicalUtf8Artifact({
      path, maxBytes: 32 * 1024 * 1024, label: "semantic chain input" }));
    let result: unknown;
    if (operation === "prepare") result = await prepareSemanticChain(json(required("--config")), required("--root"));
    else if (operation === "bind-lazy") result = await writeDirectLazyConfig({ root: required("--root"),
      chainConfig: json(required("--config")), population: json(required("--population")),
      sourcePreflightPath: required("--source-preflight"), sourceCacheRoot: required("--source-cache-root"),
      recordedAt: required("--recorded-at"), producerCommit: required("--producer-commit") }, required("--out"));
    else if (operation === "qualify-window") result = await prepareLazyQualificationWindow(json(required("--config")), required("--root"));
    else if (operation === "qualify-final") result = await sealLazyQualificationFinal(required("--root"));
    else if (operation === "qualify-replay") result = await replayLazyQualifiedFirstExposure(required("--root"));
    else if (operation === "replay") result = await replaySemanticChain(required("--root"),
      z.enum(["retained", "without_semantic_correspondences"]).parse(flags.get("--arm") ?? "retained"));
    else if (operation === "measure") result = measureSemanticChain(required("--root"), required("--replay"), json(required("--gold")));
    else if (operation === "intervene") result = interveneSemanticChain(required("--root"), required("--replay"),
      Number(flags.get("--leaf-trials") ?? "32"));
    else if (operation === "associate") {
      const population = z.object({ name: z.string(), dataDir: z.string(), pinnedMetaRoot: z.string(),
        cacheOwners: z.array(z.object({ cacheRoot: z.string().min(1),
          retainedPreparationPath: z.string().min(1) }).strict()).min(1),
        model: z.string(), requestProfile: z.string().refine(isExtractionRequestProfile),
        questionWindow: z.object({ offset: SourceRecordsDatasetSchema.shape.offset,
          limit: SourceRecordsDatasetSchema.shape.limit }).strict().optional(),
        openSemantics: z.unknown().transform(parseExtractionOpenSemanticsGeneration).optional()
      }).strict().parse(json(required("--config")));
      if (!isExtractionRequestProfile(population.requestProfile)) throw new AlayaError("VALIDATION", "unsupported extraction request profile");
      const { cacheOwners, ...sourcePopulation } = population;
      result = await prepareSourcePublicationAssociations({ ...sourcePopulation, requestProfile: population.requestProfile },
        cacheOwners, required("--out"));
    } else throw new AlayaError("VALIDATION", "expected prepare, bind-lazy, replay, measure, intervene, associate, qualify-window, qualify-final, or qualify-replay");
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
