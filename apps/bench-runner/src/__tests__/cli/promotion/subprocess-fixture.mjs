import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.env.PROMOTION_COMMAND_FIXTURE_ROOT;
const authorizationJson = process.env.PROMOTION_COMMAND_FIXTURE_AUTHORIZATION;
const mode = process.env.PROMOTION_COMMAND_FIXTURE_MODE;
if (root === undefined || authorizationJson === undefined || mode === undefined) {
  throw new Error("promotion command subprocess fixture environment is incomplete");
}

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
  const command = await server.ssrLoadModule(
    "/apps/bench-runner/src/cli/promotion/command.ts"
  );
  const exitCode = await command.runAuthorizeLongMemEvalMatrixCommand([
    "--contract", join(root, "contract.json"),
    "--out", join(root, "authorization.json")
  ], {
    authorize: async () => {
      if (mode === "failure") throw new Error("fixture authorization failure");
      return JSON.parse(authorizationJson);
    },
    stdout: (message) => process.stdout.write(message),
    stderr: (message) => process.stderr.write(message)
  });
  process.exitCode = exitCode;
} finally {
  await server.close();
}
