/** Neutral registration before a descendant imports application code. */
import { installProviderFreeBoundary } from "./provider-free-boundary.ts";

const isolation = installProviderFreeBoundary();
process.on("exit", () => {
  try { isolation.assertSafe(); }
  catch { if (process.exitCode !== isolation.signalFailureExitCode) process.exitCode = 1; }
});
