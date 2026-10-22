import { readBoundedCanonicalUtf8Artifact } from "../extraction/cache-audit/bounded-artifact-reader.js";

/** Private standalone entry. Selection has no evaluator import or label argument. */
export async function runConditionalNavigationLauncher(args: readonly string[]): Promise<number> {
  try {
    if (args.length === 6 && args[0] === "--evaluate" && args[2] === "--labels" && args[4] === "--out" && args[1] && args[3] && args[5]) {
      const result = (await import("./conditional-navigation-evaluate.js")).evaluateConditionalNavigation(args[1], args[3], args[5]);
      process.stdout.write(`${JSON.stringify(result.summary)}\n`); return 0;
    }
    const proposal = args[0] === "--propose";
    if (args.length !== 4 || (!proposal && args[0] !== "--config") || args[2] !== "--out" || !args[1] || !args[3]) {
      process.stderr.write("expected --config|--propose <input.json> --out <new-root>, or --evaluate <root> --labels <manifest> --out <file>\n"); return 2;
    }
    const config = JSON.parse(readBoundedCanonicalUtf8Artifact({ path: args[1], maxBytes: 1024 * 1024,
      label: "conditional navigation config" }));
    const receipt = proposal
      ? await (await import("./conditional-navigation-propose.js")).runNavigationProposals(config, args[3])
      : await (await import("./conditional-navigation-run.js")).runConditionalNavigation(config, args[3]);
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
