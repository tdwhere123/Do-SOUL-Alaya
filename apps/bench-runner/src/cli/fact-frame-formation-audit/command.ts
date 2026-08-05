import process from "node:process";
import { auditEvidenceFactFrameFormations } from
  "../../longmemeval/snapshot/recall-eval/fact-frame-formation/audit.js";
import { publishExclusiveOutput } from "../output/exclusive-output.js";

interface AuditCommandOptions {
  readonly snapshot: string;
  readonly output?: string;
}

export async function runFactFrameFormationAuditCommand(
  args: readonly string[]
): Promise<number> {
  try {
    const options = parseAuditCommandOptions(args);
    const report = await auditEvidenceFactFrameFormations(options.snapshot);
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (options.output !== undefined) {
      await publishExclusiveOutput(options.output, serialized);
    }
    process.stdout.write(serialized);
    return report.integrity_valid ? 0 : 1;
  } catch (error) {
    process.stderr.write(
      `alaya-bench-runner fact-frame-formation-audit: ${errorMessage(error)}\n`
    );
    return 2;
  }
}

function parseAuditCommandOptions(args: readonly string[]): AuditCommandOptions {
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
