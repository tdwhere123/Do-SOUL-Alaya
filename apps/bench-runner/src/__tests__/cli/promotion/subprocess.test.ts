import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { promotionAuthorizationFixture } from "./authorization-fixture.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../../../..");
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "subprocess-fixture.mjs");
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "matrix-promotion-process-"));
  await writeFile(join(root, "contract.json"), "contract", "utf8");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it("publishes authorization and exits zero in a real process", async () => {
  const result = await runFixture("success");

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("Authorization:");
  expect(JSON.parse(await readFile(join(root, "authorization.json"), "utf8")))
    .toEqual(promotionAuthorizationFixture());
  expect(await tempArtifacts()).toEqual([]);
}, 20_000);

it("exits nonzero without a target or temp artifact on authorization failure", async () => {
  const result = await runFixture("failure");

  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("fixture authorization failure");
  expect(existsSync(join(root, "authorization.json"))).toBe(false);
  expect(await tempArtifacts()).toEqual([]);
}, 20_000);

async function runFixture(mode: "success" | "failure") {
  const child = spawn(process.execPath, [FIXTURE], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NODE_NO_WARNINGS: "1",
      PROMOTION_COMMAND_FIXTURE_ROOT: root,
      PROMOTION_COMMAND_FIXTURE_MODE: mode,
      PROMOTION_COMMAND_FIXTURE_AUTHORIZATION: JSON.stringify(
        promotionAuthorizationFixture()
      )
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  return new Promise<{ exitCode: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (exitCode) => resolve({ exitCode, stdout, stderr }));
    }
  );
}

async function tempArtifacts(): Promise<string[]> {
  return (await readdir(root)).filter((name) => name.includes(".tmp-"));
}
