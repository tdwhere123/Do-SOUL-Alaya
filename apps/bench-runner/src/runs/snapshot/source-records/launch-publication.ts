import { publishSourceSemanticSnapshot, type SourcePublicationPopulation } from "./publish.js";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { ExtractionRequestProfile } from "../../extraction/request-profile.js";
import { isExtractionRequestProfile } from "../../extraction/request-profile.js";

/** Argv-only launcher. Source census, identity and publication stay in the maintained owners. */
export async function runSourceSemanticPublicationLauncher(args: readonly string[]): Promise<number> {
  try {
    const flags = parseFlags(args);
    globalThis.fetch = async () => {
      throw new Error("source semantic publication forbids provider calls");
    };
    const report = await publishSourceSemanticSnapshot({
      snapshotPath: required(flags, "--snapshot"),
      dataDirRoot: required(flags, "--data-dir-root"),
      recordedAt: required(flags, "--recorded-at"),
      producerCommit: required(flags, "--producer-commit"),
      workspaceId: flags.get("--workspace-id"),
      runId: flags.get("--run-id"),
      populations: [
        population(flags, "original"),
        population(flags, "challenge")
      ]
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`source semantic publication: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

function population(flags: ReadonlyMap<string, string>, name: "original" | "challenge"): SourcePublicationPopulation {
  const prefix = `--${name}`;
  const cacheRoot = flags.get(`${prefix}-cache-root`);
  const bindingsPath = flags.get(`${prefix}-publication-associations`);
  return {
    name,
    dataDir: required(flags, `${prefix}-data-dir`),
    pinnedMetaRoot: required(flags, `${prefix}-pinned-meta-root`),
    model: required(flags, "--model"),
    requestProfile: requestProfile(required(flags, "--request-profile")),
    ...(bindingsPath === undefined ? {} : { publicationAssociations: z.array(z.object({
      source_id: z.string().min(1), source_version: z.string().min(1),
      generation_key: z.string().regex(/^[a-f0-9]{64}$/u), request_digest: z.string().regex(/^[a-f0-9]{64}$/u)
    }).strict()).max(10000).parse(JSON.parse(readFileSync(bindingsPath, "utf8"))) }),
    ...(cacheRoot === undefined ? {} : { cacheRoot })
  };
}

function parseFlags(args: readonly string[]): Map<string, string> {
  const allowed = [
    "--snapshot", "--data-dir-root", "--recorded-at", "--producer-commit", "--workspace-id", "--run-id",
    "--model", "--request-profile",
    "--original-data-dir", "--original-pinned-meta-root", "--original-cache-root",
    "--challenge-data-dir", "--challenge-pinned-meta-root", "--challenge-cache-root",
    "--original-publication-associations", "--challenge-publication-associations"
  ];
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]!;
    if (!allowed.includes(flag) || flags.has(flag)) throw new Error(`unknown or repeated flag '${flag}'`);
    const value = args[index + 1];
    if (value === undefined || value.length === 0) throw new Error(`${flag} requires a value`);
    flags.set(flag, value);
  }
  return flags;
}

function required(flags: ReadonlyMap<string, string>, name: string): string {
  const value = flags.get(name);
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function requestProfile(value: string): ExtractionRequestProfile {
  if (!isExtractionRequestProfile(value)) throw new Error(`unsupported request profile '${value}'`);
  return value;
}

const entry = process.argv[1]?.replaceAll("\\", "/");
if (entry !== undefined && (entry.endsWith("/launch-publication.ts") || entry.endsWith("/launch-publication.js"))) {
  void runSourceSemanticPublicationLauncher(process.argv.slice(2)).then((code) => process.exit(code));
}
