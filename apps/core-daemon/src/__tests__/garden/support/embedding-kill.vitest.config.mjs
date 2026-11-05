import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL("../../../../../..", import.meta.url));
const packages = {
  "@do-soul/alaya-protocol": "packages/protocol/src/index.ts",
  "@do-soul/alaya-core": "packages/core/src/index.ts",
  "@do-soul/alaya-storage": "packages/storage/src/index.ts",
  "@do-soul/alaya-soul": "packages/soul/src/index.ts",
  "@do-soul/alaya-cjk-segmentation": "packages/cjk-segmentation/src/index.ts",
  "@do-soul/alaya-graph-algorithms": "packages/graph-algorithms/src/index.ts",
  "@do-soul/alaya-engine-gateway": "packages/engine-gateway/src/index.ts"
};
export default defineConfig({
  root,
  resolve: { alias: Object.entries(packages).map(([name, target]) => ({
    find: new RegExp(`^${name}$`), replacement: path.join(root, target)
  })) },
  test: { include: [path.join(root, "apps/core-daemon/src/__tests__/garden/support/embedding-kill-child.ts")],
    pool: "threads", maxWorkers: 1, minWorkers: 1, testTimeout: 30_000 }
});
