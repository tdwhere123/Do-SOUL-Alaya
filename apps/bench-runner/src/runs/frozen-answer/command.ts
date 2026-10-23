import { AlayaError } from "@do-soul/alaya-protocol";
import { consumeFrozenAnswers, type FrozenAnswerDependencies } from "./execute.js";

/** Credential access is forbidden in tests; proof injects an unauthenticated
 * loopback sender instead of installing credential-shaped environment fixtures. */
export async function runFrozenAnswerCommand(argv: readonly string[], supplied?: FrozenAnswerDependencies): Promise<number> {
  try {
    if (argv.length !== 6 || argv[0] !== "--grant" || argv[2] !== "--grant-sha256" || argv[4] !== "--mode" ||
      !["execute", "recover"].includes(argv[5]!)) throw new AlayaError("VALIDATION",
      "usage: --grant <externally-issued.json> --grant-sha256 <trusted-pin> --mode execute|recover");
    const dependencies = supplied ?? { loadConfig: await defaultConfigLoader() };
    const cancellation = new AbortController();
    const stop = () => cancellation.abort(new AlayaError("UNAVAILABLE", "answer command cancelled"));
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    try {
      const result = await consumeFrozenAnswers({ grantPin: { path: argv[1]!, sha256: argv[3]! },
        mode: argv[5] as "execute" | "recover", abortSignal: cancellation.signal }, dependencies);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return result.failure === null && result.rows.every(row => row.status === "answered") ? 0 : 1;
    } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
  } catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`); return 2;
  }
}

async function defaultConfigLoader(): Promise<FrozenAnswerDependencies["loadConfig"]> {
  // Guard before importing the credential resolver, not after it has read secrets.
  if (process.env.NODE_ENV === "test" || process.env.VITEST !== undefined || process.env.VITEST_WORKER_ID !== undefined) {
    return () => { throw new AlayaError("UNAVAILABLE", "frozen answer credential loader refuses test context"); };
  }
  const { resolveCompileSeedExtractionConfig } = await import("../compile-seed/compile-seed-config.js");
  return () => resolveCompileSeedExtractionConfig();
}
