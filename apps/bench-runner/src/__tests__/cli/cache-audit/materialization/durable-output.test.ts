import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { publishDurableExclusiveOutputUnderLease } from
  "../../../../cli/output/durable-exclusive-output.js";

const roots: string[] = [];
const childFixture = fileURLToPath(new URL("./durable-output-child.mjs", import.meta.url));
const cleanupChildFixture = fileURLToPath(
  new URL("./durable-output-cleanup-child.mjs", import.meta.url)
);
const ownershipId = "a".repeat(64);
const contents = `${JSON.stringify({ kind: "materialization-receipt" })}\n`;

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

it("recovers an ownership-bound durable temp after SIGKILL and publishes exactly once", async () => {
  const root = mkdtempSync(join(tmpdir(), "alaya-durable-output-"));
  roots.push(root);
  const outputPath = join(root, "materialization-receipt.json");
  const child = spawn(process.execPath, [childFixture], {
    cwd: join(dirname(fileURLToPath(import.meta.url)), "../../../../../../.."),
    env: {
      ...process.env,
      MATERIALIZATION_OUTPUT_PATH: outputPath,
      MATERIALIZATION_OUTPUT_CONTENTS: contents,
      MATERIALIZATION_OUTPUT_OWNERSHIP: ownershipId
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await waitForDurableFile(child);
  child.kill("SIGKILL");
  expect(await waitForClose(child)).toBe("SIGKILL");

  expect(existsSync(outputPath)).toBe(false);
  expect(readdirSync(root).filter(isPublicationTemporary)).toHaveLength(1);
  publishDurableExclusiveOutputUnderLease({ outputPath, contents, ownershipId });
  expect(readFileSync(outputPath, "utf8")).toBe(contents);
  expect(readdirSync(root).filter(isPublicationTemporary)).toEqual([]);
  publishDurableExclusiveOutputUnderLease({ outputPath, contents, ownershipId });
  expect(readFileSync(outputPath, "utf8")).toBe(contents);
}, 90_000);

it("preserves a conflicting regular file at the deterministic temporary path", () => {
  const root = mkdtempSync(join(tmpdir(), "alaya-durable-output-conflict-"));
  roots.push(root);
  const outputPath = join(root, "materialization-receipt.json");
  const temporary = deterministicTemporaryPath(outputPath);
  writeFileSync(temporary, "operator-owned\n", "utf8");

  expect(() => publishDurableExclusiveOutputUnderLease({
    outputPath, contents, ownershipId
  })).toThrow(/not an exact owned publication|content differs/u);
  expect(readFileSync(temporary, "utf8")).toBe("operator-owned\n");
  expect(existsSync(outputPath)).toBe(false);
});

it("reports an owned temporary cleanup failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "alaya-durable-output-cleanup-"));
  roots.push(root);
  const outputPath = join(root, "materialization-receipt.json");
  const child = spawn(process.execPath, [cleanupChildFixture], {
    cwd: join(dirname(fileURLToPath(import.meta.url)), "../../../../../../.."),
    env: {
      ...process.env,
      MATERIALIZATION_OUTPUT_PATH: outputPath,
      MATERIALIZATION_OUTPUT_CONTENTS: contents,
      MATERIALIZATION_OUTPUT_OWNERSHIP: ownershipId
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  expect(await readChildResult(child)).toContain("CLEANUP_FAILED:EACCES");
  expect(readFileSync(outputPath, "utf8")).toBe(contents);
  expect(readdirSync(root).filter(isPublicationTemporary)).toHaveLength(1);
});

function deterministicTemporaryPath(outputPath: string): string {
  const digest = createHash("sha256").update(outputPath).update("\0")
    .update(ownershipId).update("\0").update(contents).digest("hex");
  return join(dirname(outputPath), `.alaya-exclusive-publication-${digest}.tmp`);
}

function isPublicationTemporary(name: string): boolean {
  return name.startsWith(".alaya-exclusive-publication-") && name.endsWith(".tmp");
}

function waitForDurableFile(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timeout = setTimeout(() => reject(new Error("child did not fsync temp file")), 60_000);
    child.once("error", reject);
    child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
    child.once("close", (code) => {
      clearTimeout(timeout);
      reject(new Error(`durable output child exited ${code}: ${stderr}`));
    });
    child.stdout!.on("data", (chunk) => {
      if (!String(chunk).includes("FILE_DURABLE")) return;
      clearTimeout(timeout);
      resolve();
    });
  });
}

function waitForClose(child: ReturnType<typeof spawn>): Promise<NodeJS.Signals | null> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (_code, signal) => resolve(signal));
  });
}

function readChildResult(child: ReturnType<typeof spawn>): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.once("error", reject);
    child.stdout!.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
    child.once("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`cleanup child exited ${code}: ${stderr}`));
    });
  });
}
