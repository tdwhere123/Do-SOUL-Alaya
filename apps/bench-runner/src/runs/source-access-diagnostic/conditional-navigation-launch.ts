import { readBoundedCanonicalUtf8Artifact } from "../extraction/cache-audit/bounded-artifact-reader.js";

/** Private standalone entry. Selection has no evaluator import or label argument. */
export async function runConditionalNavigationLauncher(args: readonly string[]): Promise<number> {
  try {
    if (args.length !== 4 || args[0] !== "--config" || args[2] !== "--out" || !args[1] || !args[3]) {
      process.stderr.write("expected --config <input.json> --out <new-root>\n"); return 2;
    }
    const config = JSON.parse(readBoundedCanonicalUtf8Artifact({ path: args[1], maxBytes: 1024 * 1024,
      label: "conditional navigation config" }));
    const receipt = await (await import("./conditional-navigation-run.js")).runConditionalNavigation(config, args[3]);
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
    return receipt.status === "complete" ? 0 : 2;
  } catch (error) {
    process.stderr.write(`conditional navigation: ${error instanceof Error ? error.message : String(error)}\n`); return 2;
  }
}
const entry = process.argv[1]?.replaceAll("\\", "/");
if (entry?.endsWith("/conditional-navigation-launch.ts") || entry?.endsWith("/conditional-navigation-launch.js")) {
  void runConditionalNavigationLauncher(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
