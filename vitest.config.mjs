import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: [path.resolve(rootDir, "src/__tests__/**/*.{test,spec}.ts")],
    exclude: [path.resolve(rootDir, "dist/**")],
    testTimeout: 15000
  }
});
