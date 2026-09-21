import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = process.cwd();
const cacheRoot = process.env.PROPOSAL_CACHE_ROOT;
const mode = process.env.PROPOSAL_PROCESS_MODE;
if (cacheRoot === undefined || mode === undefined) {
  throw new Error("semantic proposal process fixture environment is incomplete");
}

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
  server: { middlewareMode: true },
  resolve: benchProject.resolve
});
try {
  const guard = await server.ssrLoadModule(
    "/apps/bench-runner/src/runs/extraction/fill/manifest/fill-root-guard.ts"
  );
  if (mode === "hold") {
    const lease = guard.acquireExtractionCacheWriteLease(cacheRoot);
    process.stdout.write("HELD\n");
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, Number(process.env.PROPOSAL_HOLD_MS ?? 4000));
      process.on("SIGTERM", () => {
        clearTimeout(timer);
        resolve(undefined);
      });
    });
    lease.release();
    process.exit(0);
  }
  try {
    const lease = guard.acquireExtractionCacheWriteLease(cacheRoot);
    lease.release();
    process.stdout.write("ACQUIRED\n");
    process.exit(0);
  } catch (cause) {
    process.stderr.write(cause instanceof Error ? cause.message : String(cause));
    process.exit(2);
  }
} finally {
  await server.close();
}
