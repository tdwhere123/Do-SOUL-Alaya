import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { assertExactTargetTree, assertRecoverableTargetTree, removeEmptyStage } from
  "../../../runs/extraction/cache-audit/materialization/target-tree.js";
import { MATERIALIZATION_STAGE_NAME } from
  "../../../runs/extraction/cache-audit/materialization/contract.js";
import { linkFileExclusiveDurable, writeBytesExclusiveDurable } from
  "../../../runs/extraction/fill/manifest/durable-exclusive-publication.js";
import type { MaterializationShardDescriptor } from
  "../../../runs/extraction/cache-audit/materialization/contract.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const key = "ab" + "1".repeat(62), bytes = "retained shard bytes";
const descriptor: MaterializationShardDescriptor = { cache_key: key, raw_json_sha256: "0".repeat(64),
  file_sha256: createHash("sha256").update(bytes).digest("hex"), byte_length: Buffer.byteLength(bytes) };
function tree() {
  const root = mkdtempSync(join(tmpdir(), "target-tree-")); roots.push(root);
  mkdirSync(join(root, "ab"));
  return root;
}

it("accepts a native shard tree through publication states, recovery and committed validation", () => {
  const root = tree();
  assertExactTargetTree(root, [descriptor], "fresh");
  writeFileSync(join(root, "ab", `${key}.json`), bytes);
  assertRecoverableTargetTree(root, [descriptor], 1024);
  for (const state of ["open", "manifest", "committed"] as const) assertExactTargetTree(root, [descriptor], state);
  expect(() => assertExactTargetTree(root, [descriptor], "fresh")).toThrow(/partial target/u);
  writeFileSync(join(root, "ab", `${key}.json`), "different bytes");
  expect(() => assertRecoverableTargetTree(root, [descriptor], 1024)).toThrow(/differs/u);
});

it("resumes a partially published native shard tree without accepting an open stage as committed", () => {
  const root = tree();
  assertExactTargetTree(root, [descriptor], "fresh");
  const stage = join(root, MATERIALIZATION_STAGE_NAME);
  mkdirSync(stage);
  const staged = join(stage, `${key}.json`), published = join(root, "ab", `${key}.json`);
  writeBytesExclusiveDurable(staged, Buffer.from(bytes));
  assertRecoverableTargetTree(root, [descriptor], 1024);
  linkFileExclusiveDurable(staged, published);
  assertRecoverableTargetTree(root, [descriptor], 1024);
  expect(() => assertExactTargetTree(root, [descriptor], "committed")).toThrow(/stage/u);
  rmSync(staged);
  removeEmptyStage(root);
  assertExactTargetTree(root, [descriptor], "committed");
});

it("accepts genuinely empty fresh and committed trees", () => {
  const root = mkdtempSync(join(tmpdir(), "target-tree-")); roots.push(root);
  assertExactTargetTree(root, [], "fresh");
  assertExactTargetTree(root, [], "committed");
});

it("rejects a linked shard prefix even when the external tree contains the exact expected bytes", () => {
  const root = tree(), outside = tree();
  writeFileSync(join(outside, "ab", `${key}.json`), bytes);
  assertExactTargetTree(outside, [descriptor], "committed");
  rmSync(join(root, "ab"), { recursive: true });
  symlinkSync(join(outside, "ab"), join(root, "ab"), process.platform === "win32" ? "junction" : "dir");
  expect(() => assertExactTargetTree(root, [descriptor], "committed")).toThrow();
  expect(() => assertRecoverableTargetTree(root, [descriptor], 1024)).toThrow();
});

it("rejects prefix/key mismatches, unknown files, symlinks and unexpected empty prefixes", () => {
  const root = tree();
  const wrongKey = "cd" + "1".repeat(62);
  writeFileSync(join(root, "ab", `${wrongKey}.json`), bytes);
  expect(() => assertExactTargetTree(root, [{ ...descriptor, cache_key: wrongKey }], "committed"))
    .toThrow(/unexpected empty shard prefix/u);
  rmSync(join(root, "ab", `${wrongKey}.json`));
  writeFileSync(join(root, "ab", "unknown.json"), bytes);
  expect(() => assertExactTargetTree(root, [descriptor], "committed")).toThrow(/unknown or unsafe/u);
  rmSync(join(root, "ab", "unknown.json"));
  const outside = mkdtempSync(join(tmpdir(), "target-tree-outside-")); roots.push(outside);
  const outsideFile = join(outside, `${key}.json`);
  writeFileSync(outsideFile, bytes);
  // Windows junctions exercise real reparse points without requiring symlink privileges.
  symlinkSync(process.platform === "win32" ? outside : outsideFile, join(root, "ab", `${key}.json`),
    process.platform === "win32" ? "junction" : "file");
  expect(() => assertRecoverableTargetTree(root, [descriptor], 1024)).toThrow(/unknown or unsafe/u);
  rmSync(join(root, "ab", `${key}.json`), { recursive: true });
  expect(() => assertExactTargetTree(root, [], "committed")).toThrow(/unexpected empty shard prefix/u);
});
