import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@do-soul/alaya-protocol": path.resolve(
        __dirname,
        "../../../packages/protocol/src/index.ts"
      )
    }
  },
  test: {
    name: "@do-soul/alaya-inspector-web",
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    css: false
  }
});
