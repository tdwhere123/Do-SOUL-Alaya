import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { assertExactTargetTree, assertRecoverableTargetTree } from
  "../../../runs/extraction/cache-audit/materialization/target-tree.js";
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
  symlinkSync(join(root, "outside.json"), join(root, "ab", `${key}.json`));
  expect(() => assertRecoverableTargetTree(root, [descriptor], 1024)).toThrow(/unknown or unsafe/u);
  rmSync(join(root, "ab", `${key}.json`));
  expect(() => assertExactTargetTree(root, [], "committed")).toThrow(/unexpected empty shard prefix/u);
});
