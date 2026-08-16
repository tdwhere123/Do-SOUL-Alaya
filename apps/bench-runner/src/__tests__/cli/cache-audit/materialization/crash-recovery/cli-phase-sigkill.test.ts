import { spawn } from "node:child_process";
import {
  existsSync, mkdirSync, readFileSync, writeFileSync
} from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../../../../../cli/cli.js";
import {
  cleanupMaterializerFixtures, createMaterializerFixture
} from "../../materializer-fixture.js";

const CHILD_ARGS_ENV = "ALAYA_TEST_MATERIALIZATION_CHILD_ARGS";
const FAILPOINT_ENV = "ALAYA_TEST_MATERIALIZATION_SIGKILL_AFTER";
const phases = [
  "journal-published", "stage-entry-published", "manifest-published",
  "commit-published-before-journal-unlink", "journal-unlinked"
] as const;

afterEach(() => {
  vi.restoreAllMocks();
  cleanupMaterializerFixtures();
});

if (process.env[CHILD_ARGS_ENV] !== undefined) {
  it("runs the real public CLI in the crash child", async () => {
    const args = JSON.parse(process.env[CHILD_ARGS_ENV]!) as string[];
    expect(await runCli(args)).toBe(0);
  });
} else {
  describe("public CLI materialization transaction SIGKILL recovery", () => {
    it.each(phases)("resumes after %s with a later clock", async (phase) => {
      const fixture = createCliFixture();
      const crashed = await runCrashChild(fixture.args, phase);
      expect(crashed).toMatchObject({ code: null, signal: "SIGKILL" });
      expect(existsSync(fixture.receiptPath)).toBe(false);

      expect(await runQuiet(fixture.args)).toBe(0);
      const receipt = readFileSync(fixture.receiptPath);
      expect(await runQuiet(fixture.args)).toBe(0);
      expect(readFileSync(fixture.receiptPath)).toEqual(receipt);
    }, 30_000);
  });
}

function createCliFixture() {
  const fixture = createMaterializerFixture({ rawJsonPaddingBytes: 32 * 1024 });
  const auditOutput = join(fixture.root, "audit");
  const selectionPath = join(fixture.root, "target-selection.json");
  const receiptPath = join(fixture.root, "materialization-receipt.json");
  mkdirSync(auditOutput);
  writeFileSync(join(auditOutput, "audit-receipt.json"), json(fixture.auditReceipt));
  writeFileSync(join(auditOutput, "raw-inventory.json"), json({
    sha256: fixture.auditReceipt.raw_inventory_sha256, inventory: fixture.inventory
  }));
  writeFileSync(join(auditOutput, "source-manifest.json"), fixture.sourceManifestRaw);
  writeFileSync(selectionPath, json(fixture.targetSelection));
  const args = [
    "materialize-audited-extraction-target", "--cache-audit-output", auditOutput,
    "--extraction-cache-root", fixture.targetRoot,
    "--extraction-target-selection", selectionPath,
    "--materialization-receipt-out", receiptPath
  ];
  return { ...fixture, receiptPath, args };
}

function runCrashChild(args: readonly string[], phase: typeof phases[number]): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}> {
  const child = spawn(process.execPath, [
    join(process.cwd(), "node_modules/vitest/vitest.mjs"), "run",
    fileURLToPath(import.meta.url), "--pool=threads", "--maxWorkers=1"
  ], {
    cwd: process.cwd(), stdio: ["ignore", "ignore", "ignore"],
    env: {
      ...process.env, [CHILD_ARGS_ENV]: JSON.stringify(args), [FAILPOINT_ENV]: phase
    }
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

async function runQuiet(args: readonly string[]): Promise<number> {
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  return await runCli(args);
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
