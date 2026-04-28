import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { sharedAlias } from "../../vitest.config.mjs";

const packageDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: sharedAlias
  },
  test: {
    name: "@do-what/core",
    environment: "node",
    include: [
      path.resolve(packageDir, "src/__tests__/**/*.{test,spec}.ts")
    ],
    exclude: ["**/dist/**"]
  }
});
