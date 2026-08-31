import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveBenchCheckoutRoot } from "./checkout-root.js";

const execFileAsync = promisify(execFile);

export async function computeExecutedDistIdentityFresh(): Promise<unknown> {
  const checkoutRoot = resolveBenchCheckoutRoot();
  const script = join(checkoutRoot, "apps/bench-runner/scripts/executed-dist-closure.mjs");
  const { stdout } = await execFileAsync(process.execPath, [script, "--root", checkoutRoot]);
  return JSON.parse(stdout);
}
