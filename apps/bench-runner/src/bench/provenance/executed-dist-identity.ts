import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function computeExecutedDistIdentityFresh(): Promise<unknown> {
  const checkoutRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
  const script = join(checkoutRoot, "apps/bench-runner/scripts/executed-dist-closure.mjs");
  const { stdout } = await execFileAsync(process.execPath, [script, "--root", checkoutRoot]);
  return JSON.parse(stdout);
}
