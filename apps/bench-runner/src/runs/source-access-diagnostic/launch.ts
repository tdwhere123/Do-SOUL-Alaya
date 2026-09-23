import { AlayaError } from "@do-soul/alaya-protocol";
import { readBoundedCanonicalUtf8Artifact } from "../extraction/cache-audit/bounded-artifact-reader.js";

/** Private access-only diagnostic. Gold remains behind the separate evaluate operation. */
export async function runSourceAccessDiagnosticLauncher(args: readonly string[]): Promise<number> {
  try {
    const [operation, ...rest] = args;
    const allowed = operation === "observe" ? ["--config", "--out"]
      : operation === "evaluate" ? ["--observation", "--out"] : [];
    if (allowed.length === 0 || rest.length !== 4) {
      throw new AlayaError("VALIDATION", "expected observe --config <file> --out <new-root> or evaluate --observation <file> --out <new-root>");
    }
    const flags = new Map<string, string>();
    for (let index = 0; index < rest.length; index += 2) {
      const key = rest[index]!, value = rest[index + 1];
      if (!allowed.includes(key) || flags.has(key) || !value) {
        throw new AlayaError("VALIDATION", "invalid access diagnostic arguments");
      }
      flags.set(key, value);
    }
    if (flags.size !== 2) throw new AlayaError("VALIDATION", "missing access diagnostic argument");
    const required = (key: string) => flags.get(key)!;
    const result = operation === "observe"
      ? await (await import("./observe.js")).observeSourceAccessDiagnostic(JSON.parse(readBoundedCanonicalUtf8Artifact({
        path: required("--config"), maxBytes: 1024 * 1024, label: "source access diagnostic config"
      })), required("--out"))
      : await (await import("./evaluate.js")).evaluateSourceAccessDiagnostic(required("--observation"), required("--out"));
    process.stdout.write(`${JSON.stringify({ path: result.path, status: "status" in result.result ? result.result.status : "evaluated" })}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`source access diagnostic: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

const entry = process.argv[1]?.replaceAll("\\", "/");
if (entry?.endsWith("/source-access-diagnostic/launch.ts") || entry?.endsWith("/source-access-diagnostic/launch.js")) {
  void runSourceAccessDiagnosticLauncher(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
