import path from "node:path";
import { defineConfig } from "vitest/config";
import { sharedAlias } from "../../vitest.config.mjs";

const rootDir = path.resolve(import.meta.dirname, "../..");

export default defineConfig({
  resolve: {
    alias: sharedAlias
  },
  test: {
    name: "@do-what/soul",
    environment: "node",
    include: [path.resolve(rootDir, "packages/soul/src/__tests__/**/*.{test,spec}.ts")],
    exclude: ["**/dist/**"]
  }
});
