import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { posix, win32 } from "node:path";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

// Execute the actual builtins-only capture function with explicit platform path
// semantics. The filesystem oracle is independent; native launch tests retain
// responsibility for real module hashing and child execution.
const source = readFileSync(new URL("../../../runs/semantic-chain/source-acquisition-launch.mjs", import.meta.url), "utf8");
const start = source.indexOf("export function captureAcquisitionLaunchBinding()");
const end = source.indexOf("export function assertAcquisitionLaunchBinding", start);
assert(start >= 0 && end > start);
const capture = source.slice(start, end).replace("export function", "function");
function captureRoot(candidate: string, physical: string, paths: typeof posix) {
  return runInNewContext(`${capture}\ncaptureAcquisitionLaunchBinding().candidate`, {
    assert, candidate, pinnedPaths: [], process: { execPath: "fixture-node" },
    resolve: paths.resolve, join: paths.join,
    realpathSync: (path: string) => path === "fixture-node" ? path : physical
  });
}

it.each([
  ["Windows trailing separator", "D:\\a\\checkout\\", "D:\\a\\checkout", win32],
  ["Windows drive root", "D:\\", "D:\\", win32],
  ["Windows UNC root", "\\\\server\\share\\checkout\\", "\\\\server\\share\\checkout", win32],
  ["POSIX trailing separator", "/work/checkout/", "/work/checkout", posix],
  ["POSIX literal backslash", "/work/checkout\\/", "/work/checkout\\", posix]
] as const)("captures the unaliased %s without lexical path corruption", (_label, named, physical, paths) => {
  expect(captureRoot(named, physical, paths)).toBe(physical);
});

it.each([
  ["D:\\alias\\", "D:\\physical", win32],
  ["/alias/", "/physical", posix],
  ["/work/checkout\\/", "/work/checkout", posix]
] as const)("rejects an aliased or distinct named root %s", (named, physical, paths) => {
  expect(() => captureRoot(named, physical, paths)).toThrow();
});
