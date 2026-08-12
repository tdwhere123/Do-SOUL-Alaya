import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { MATERIALIZATION_STAGE_NAME } from
  "../../../../longmemeval/extraction/cache-audit/materialization/contract.js";
import {
  cleanupMaterializerFixtures,
  createMaterializerFixture,
  materialize,
  writeOpenMaterializationJournal
} from "../materializer-fixture.js";

afterEach(cleanupMaterializerFixtures);

it("requires explicit stale-lock cleanup after SIGKILL, then settles identically", async () => {
  const fixture = createMaterializerFixture();
  writeOpenMaterializationJournal(fixture);
  const stage = join(fixture.targetRoot, MATERIALIZATION_STAGE_NAME);
  mkdirSync(stage);
  writeFileSync(join(stage, `${fixture.hitKeys[0]!}.json`), "partial", "utf8");
  const child = spawn(process.execPath, [
    fileURLToPath(new URL("./stale-lock-child.mjs", import.meta.url)),
    fixture.sourceRoot,
    fixture.targetRoot
  ], { stdio: ["ignore", "pipe", "pipe"] });
  await waitForReady(child);
  child.kill("SIGKILL");
  await waitForClose(child);

  expect(() => materialize(fixture)).toThrow(/lease.*failed|writer lock/iu);
  for (const root of [fixture.sourceRoot, fixture.targetRoot]) {
    const lock = join(root, ".extraction-fill.lock");
    expect(existsSync(lock)).toBe(true);
    rmSync(lock, { recursive: true });
  }
  const settled = materialize(fixture);
  expect(materialize(fixture)).toEqual(settled);
});

function waitForReady(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("child did not acquire locks")), 5_000);
    child.once("error", reject);
    child.stdout!.on("data", (chunk) => {
      if (!String(chunk).includes("LOCKS_READY")) return;
      clearTimeout(timeout);
      resolve();
    });
  });
}

function waitForClose(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", () => resolve());
  });
}
