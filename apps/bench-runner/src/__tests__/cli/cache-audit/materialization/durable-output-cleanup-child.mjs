import { createRequire, syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const outputPath = process.env.MATERIALIZATION_OUTPUT_PATH;
const contents = process.env.MATERIALIZATION_OUTPUT_CONTENTS;
const ownershipId = process.env.MATERIALIZATION_OUTPUT_OWNERSHIP;
if (outputPath === undefined || contents === undefined || ownershipId === undefined) {
  throw new Error("durable output cleanup child environment is incomplete");
}

fs.unlinkSync = () => {
  const error = new Error("injected unlink failure");
  error.code = "EACCES";
  throw error;
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
  try {
    output.publishDurableExclusiveOutputUnderLease({ outputPath, contents, ownershipId });
    throw new Error("cleanup failure was swallowed");
  } catch (cause) {
    process.stdout.write(`CLEANUP_FAILED:${cause?.code ?? cause?.message ?? String(cause)}\n`);
  }
} finally {
  await server.close();
}
