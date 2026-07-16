import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = process.cwd();
const fixtureRoot = process.env.EXTRACTION_FILL_FIXTURE_ROOT;
const mode = process.env.EXTRACTION_FILL_FIXTURE_MODE;
if (fixtureRoot === undefined || mode === undefined) {
  throw new Error("extraction-fill subprocess fixture environment is incomplete");
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
  const cli = await server.ssrLoadModule("/apps/bench-runner/src/cli/cli-commands.ts");
  const fill = await server.ssrLoadModule(
    "/apps/bench-runner/src/longmemeval/extraction-fill.ts"
  );
  const exitCode = await cli.runExtractionFillCommand(
    { variant: "longmemeval_oracle", concurrency: 2 },
    {
      signalSource: process,
      runExtractionFill: (options) => fill.runExtractionFill({
        ...options,
        cacheRoot: join(fixtureRoot, "cache"),
        dataDir: join(fixtureRoot, "data"),
        pinnedMetaRoot: join(fixtureRoot, "pinned"),
        extractorFactory: () => createFixtureExtractor(mode)
      })
    }
  );
  process.exitCode = exitCode;
} finally {
  await server.close();
}

function createFixtureExtractor(fixtureMode) {
  let calls = 0;
  let releasePeer;
  const peerStarted = new Promise((resolve) => {
    releasePeer = resolve;
  });
  return {
    extract: async (input) => {
      calls += 1;
      if (fixtureMode === "terminal" && calls === 1) {
        await peerStarted;
        const error = new Error("sk-fixture-secret PROMPT_BODY");
        error.benchRetry = {
          retryCount: 3,
          retryClassification: "failure_non_retryable_4xx",
          rateLimitRetries: 0
        };
        throw error;
      }
      releasePeer();
      process.stdout.write("FIXTURE_READY\n");
      return waitForAbort(input.abortSignal);
    }
  };
}

function waitForAbort(signal) {
  return new Promise((_resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(
      () => reject(new Error("fixture peer was not cooperatively aborted")),
      2_000
    );
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}
