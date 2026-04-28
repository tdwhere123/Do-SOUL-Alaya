import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    workspace: "./vitest.workspace.mjs",
    reporters: ["default"],
    coverage: {
      enabled: false,
      provider: "v8",
      reporter: ["text", "html"],
    },
  },
});
