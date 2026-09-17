import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const [config, output] = process.argv.slice(2);
if (!config || !output) throw new Error("Usage: pnpm replay:enrichment-admission <config.json> <derived-output-directory>");
const input = JSON.parse(readFileSync(config, "utf8"));
for (const name of ["sourcePath", "regressionPath", "canonicalPath"]) readFileSync(input[name]);
for (const name of ["source-map.json", "preflight.json"]) readFileSync(join(input.preparationDirectory, name));
readFileSync(join(input.cacheRoot, `batch-state-${input.planIdentity}.json`));
const resultSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) {
  throw new Error("retained replay requires a clean committed candidate");
}
mkdirSync(output, { recursive: true });
const reportPath = join(resolve(output), `replay-files-${resultSha}-${Date.now()}.json`);
const files = [
  "apps/core-daemon/src/__tests__/runtime/recall/retained-admission-replay.test.ts",
  "apps/core-daemon/src/__tests__/runtime/recall/source-discovery-admitted-public-entry.test.ts",
  "apps/core-daemon/src/__tests__/runtime/recall/source-discovery-public-consumption.test.ts"];
const result = spawnSync("pnpm", ["exec", "vitest", "run", ...files,
  "--reporter=default", "--reporter=json", `--outputFile.json=${reportPath}`], {
  stdio: "inherit", env: { ...process.env,
    ALAYA_RETAINED_ADMISSION_CONFIG: resolve(config), ALAYA_ADMISSION_EVIDENCE_DIRECTORY: resolve(output) }
});
if (result.error) throw result.error;
writeFileSync(`${reportPath}.execution.json`, JSON.stringify({ result_sha: resultSha,
  expected_files: files, config: resolve(config), report: reportPath,
  outcome: result.status === 0 ? "success" : "failure", exit_code: result.status }, null, 2) + "\n", { flag: "wx" });
process.exitCode = result.status ?? 1;
