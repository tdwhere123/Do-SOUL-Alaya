import { beforeEach, expect, it, vi } from "vitest";
const tree = vi.hoisted(() => ({ prefix: "ab", filename: "ab" + "1".repeat(62) + ".json", symlink: false }));
// Exercise the actual traversal/comparison with native Windows path algebra on
// every host. Filesystem syscalls are simulated here; target-tree.test.ts covers
// real files on the host. This is not a native Windows filesystem verification.
vi.mock("node:path", async () => (await vi.importActual<typeof import("node:path")>("node:path")).win32);
vi.mock("node:fs", () => ({
  existsSync: () => true,
  lstatSync: () => ({ isDirectory: () => true, isSymbolicLink: () => false }),
  readdirSync: (path: string) => path === "C:\\target"
    ? [{ name: tree.prefix }]
    : [{ name: tree.filename, isFile: () => true, isSymbolicLink: () => tree.symlink }],
  rmdirSync: vi.fn()
}));
vi.mock("../../../runs/extraction/fill/manifest/durable-exclusive-publication.js", () => ({ fsyncDirectory: vi.fn() }));
vi.mock("../../../runs/extraction/fill/manifest/fill-root-guard.js", () => ({ isStableLeasePath: () => false }));
vi.mock("../../../runs/fs/opened-contained-path.js", () => ({ isPhysicalNamedPath: () => true }));
vi.mock("../../../runs/compile-seed/compile-seed-cache.js", () => ({ cacheFilePath: () => "unused" }));
vi.mock("../../../runs/extraction/cache-audit/materialization/contract.js", () => ({
  MATERIALIZATION_COMMIT_NAME: "commit", MATERIALIZATION_JOURNAL_NAME: "journal", MATERIALIZATION_STAGE_NAME: "stage"
}));
vi.mock("../../../runs/extraction/cache-audit/materialization/descriptor-io.js", () => ({ readStableRegularFileNoFollow: vi.fn() }));
import { assertExactTargetTree } from "../../../runs/extraction/cache-audit/materialization/target-tree.js";
const key = "ab" + "1".repeat(62);
const descriptors = [{ cache_key: key, raw_json_sha256: "0".repeat(64), file_sha256: "0".repeat(64), byte_length: 1 }];
beforeEach(() => { tree.prefix = "ab"; tree.filename = `${key}.json`; tree.symlink = false; });
it.each(["open", "manifest", "committed"] as const)("accepts native Windows shard coordinates in %s state", state => {
  expect(() => assertExactTargetTree("C:\\target", descriptors, state)).not.toThrow();
});
it("still rejects wrong prefixes, extra path components and symlinks", () => {
  tree.prefix = "cd";
  expect(() => assertExactTargetTree("C:\\target", descriptors, "committed")).toThrow();
  tree.prefix = "ab"; tree.filename = `..\\${key}.json`;
  expect(() => assertExactTargetTree("C:\\target", descriptors, "committed")).toThrow();
  tree.filename = `${key}.json`; tree.symlink = true;
  expect(() => assertExactTargetTree("C:\\target", descriptors, "committed")).toThrow();
});
