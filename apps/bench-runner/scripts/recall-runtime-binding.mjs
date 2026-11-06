import { createHash } from "node:crypto";
import { readdirSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AlayaError } from "@do-soul/alaya-protocol";

/** Loaded source revision and emitted runtime bytes are separate evidence. No build is performed. */
export function captureRecallRuntimeBuild(repo, revision) {
  const roots = ["apps/core-daemon", "apps/bench-runner", ...["protocol", "core", "storage", "soul", "engine-gateway",
    "eval", "cjk-segmentation", "graph-algorithms"].map(name => `packages/${name}`)];
  const files = [];
  const visit = path => {
    const stat = lstatSync(join(repo, path));
    if (stat.isSymbolicLink()) throw new AlayaError("CONFLICT", "runtime build contains a symlink");
    if (stat.isDirectory()) for (const name of readdirSync(join(repo, path)).sort()) visit(`${path}/${name}`);
    else if (stat.isFile()) files.push({ path, sha256: createHash("sha256").update(readFileSync(join(repo, path))).digest("hex") });
    else throw new AlayaError("CONFLICT", "runtime build contains a non-regular file");
  };
  for (const root of roots) { visit(`${root}/dist`); visit(`${root}/package.json`); }
  visit("pnpm-lock.yaml");
  return { source_revision: revision, build_sha256: createHash("sha256").update(JSON.stringify(files)).digest("hex"), files };
}
