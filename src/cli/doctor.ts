import { createAlayaRuntime } from "../runtime/runtime.js";
import { createDoctorFailureReport } from "../doctor/report.js";
import { redactString } from "../runtime/redaction.js";

export interface CliIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

interface DoctorCliArgs {
  readonly dataDir: string;
  readonly pretty: boolean;
}

export async function runCli(argv: readonly string[], io: CliIo = process): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== "doctor") {
    io.stderr.write("Usage: alaya doctor --data-dir <path> [--pretty]\n");
    return 2;
  }

  let args: DoctorCliArgs;
  try {
    args = parseDoctorArgs(rest);
  } catch (error) {
    io.stderr.write(`${redactString(error instanceof Error ? error.message : String(error))}\n`);
    return 2;
  }

  let runtime;
  try {
    runtime = await createAlayaRuntime({ dataDir: args.dataDir });
  } catch (error) {
    io.stdout.write(`${JSON.stringify(createDoctorFailureReport(error), null, args.pretty ? 2 : 0)}\n`);
    return 1;
  }
  try {
    const report = await runtime.doctor();
    io.stdout.write(`${JSON.stringify(report, null, args.pretty ? 2 : 0)}\n`);
    return 0;
  } finally {
    await runtime.close();
  }
}

function parseDoctorArgs(args: readonly string[]): DoctorCliArgs {
  let dataDir: string | undefined;
  let pretty = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--pretty") {
      pretty = true;
      continue;
    }
    if (arg === "--data-dir") {
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error("--data-dir requires a path.");
      }
      dataDir = next;
      index += 1;
      continue;
    }
    throw new Error(`Unknown doctor argument: ${arg}`);
  }

  if (dataDir === undefined || dataDir.trim().length === 0) {
    throw new Error("doctor requires --data-dir <path>.");
  }

  return { dataDir, pretty };
}
