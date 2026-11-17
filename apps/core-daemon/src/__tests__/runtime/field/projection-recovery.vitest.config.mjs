import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import projects from "../../../../../../vitest.workspace.mjs";
const project = projects.find(candidate => candidate.test?.name === "@do-soul/alaya-core-daemon");
if (project === undefined) throw new Error("daemon test project unavailable");
export default defineConfig({
  root: fileURLToPath(new URL("../../../../../../", import.meta.url)),
  resolve: project.resolve,
  test: {
    include: ["apps/core-daemon/src/__tests__/runtime/field/projection-recovery-child.ts"],
    pool: "threads", maxWorkers: 1, minWorkers: 1, testTimeout: 30_000
  }
});
