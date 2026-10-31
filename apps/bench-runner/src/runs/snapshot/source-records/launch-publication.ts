import { AlayaError } from "@do-soul/alaya-protocol";
import { publishSourceSemanticSnapshot, type SourcePublicationPopulation } from "./publish.js";
import type { ExtractionRequestProfile } from "../../extraction/request-profile.js";
import { isExtractionRequestProfile } from "../../extraction/request-profile.js";

/** Argv-only launcher. Source census, identity and publication stay in the maintained owners. */
export async function runSourceSemanticPublicationLauncher(args: readonly string[]): Promise<number> {
  try {
    const flags = parseFlags(args);
    globalThis.fetch = async () => {
      throw new AlayaError("CONFLICT", "source semantic publication forbids provider calls");
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
  return {
    name,
    dataDir: required(flags, `${prefix}-data-dir`),
    pinnedMetaRoot: required(flags, `${prefix}-pinned-meta-root`),
    model: required(flags, "--model"),
    requestProfile: requestProfile(required(flags, "--request-profile"))
  };
}

function parseFlags(args: readonly string[]): Map<string, string> {
  const allowed = [
    "--snapshot", "--data-dir-root", "--recorded-at", "--producer-commit", "--workspace-id", "--run-id",
    "--model", "--request-profile",
    "--original-data-dir", "--original-pinned-meta-root",
    "--challenge-data-dir", "--challenge-pinned-meta-root"
  ];
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]!;
    if (!allowed.includes(flag) || flags.has(flag)) throw new AlayaError("VALIDATION", `unknown or repeated flag '${flag}'`);
    const value = args[index + 1];
    if (value === undefined || value.length === 0) throw new AlayaError("VALIDATION", `${flag} requires a value`);
    flags.set(flag, value);
  }
  return flags;
}

function required(flags: ReadonlyMap<string, string>, name: string): string {
  const value = flags.get(name);
  if (value === undefined || value.length === 0) throw new AlayaError("VALIDATION", `${name} is required`);
  return value;
}

function requestProfile(value: string): ExtractionRequestProfile {
  if (!isExtractionRequestProfile(value)) throw new AlayaError("VALIDATION", `unsupported request profile '${value}'`);
  return value;
}

const entry = process.argv[1]?.replaceAll("\\", "/");
if (entry !== undefined && (entry.endsWith("/launch-publication.ts") || entry.endsWith("/launch-publication.js"))) {
  void runSourceSemanticPublicationLauncher(process.argv.slice(2)).then((code) => process.exit(code));
}
