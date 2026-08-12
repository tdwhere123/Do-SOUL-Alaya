import { createRequire, syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const outputPath = process.env.MATERIALIZATION_OUTPUT_PATH;
const contents = process.env.MATERIALIZATION_OUTPUT_CONTENTS;
const ownershipId = process.env.MATERIALIZATION_OUTPUT_OWNERSHIP;
if (outputPath === undefined || contents === undefined || ownershipId === undefined) {
  throw new Error("durable output child environment is incomplete");
}

const originalFsyncSync = fs.fsyncSync;
let blocked = false;
fs.fsyncSync = (fd) => {
  originalFsyncSync(fd);
  if (blocked) return;
  blocked = true;
  process.stdout.write("FILE_DURABLE\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};
syncBuiltinESMExports();

const repoRoot = process.cwd();
const require = createRequire(import.meta.url);
const vitestPackage = require.resolve("vitest/package.json");
const viteEntry = createRequire(vitestPackage).resolve("vite");
const { createServer } = await import(pathToFileURL(viteEntry).href);
const workspace = await import(pathToFileURL(join(repoRoot, "vitest.workspace.mjs")).href);
const benchProject = workspace.default.find(
  (project) => project?.test?.name === "@do-soul/alaya-bench-runner"
);
if (benchProject === undefined) throw new Error("bench-runner Vite project is unavailable");

const server = await createServer({
  root: repoRoot,
  configFile: false,
  appType: "custom",
  server: { middlewareMode: true, ws: false },
  resolve: benchProject.resolve
});

try {
  const output = await server.ssrLoadModule(
    "/apps/bench-runner/src/cli/output/durable-exclusive-output.ts"
  );
  output.publishDurableExclusiveOutputUnderLease({ outputPath, contents, ownershipId });
} finally {
  await server.close();
}
