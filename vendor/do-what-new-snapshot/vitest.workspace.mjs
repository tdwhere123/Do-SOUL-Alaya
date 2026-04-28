import { defineProject, defineWorkspace } from "vitest/config";

export default defineWorkspace([
  defineProject({
    extends: "./vitest.config.mjs",
    test: {
      name: "@do-what/protocol",
      include: ["packages/protocol/src/__tests__/**/*.test.ts"]
    }
  }),
  defineProject({
    extends: "./vitest.config.mjs",
    test: {
      name: "@do-what/soul",
      include: ["packages/soul/src/__tests__/**/*.test.ts"]
    }
  }),
  defineProject({
    extends: "./vitest.config.mjs",
    test: {
      name: "@do-what/core",
      include: ["packages/core/src/__tests__/**/*.test.ts"]
    }
  }),
  defineProject({
    extends: "./vitest.config.mjs",
    test: {
      name: "@do-what/core-daemon",
      include: ["apps/core-daemon/src/__tests__/**/*.test.ts"]
    }
  }),
  defineProject({
    extends: "./vitest.config.mjs",
    test: {
      name: "@do-what/engine-gateway",
      include: ["packages/engine-gateway/src/__tests__/**/*.test.ts"]
    }
  }),
  defineProject({
    extends: "./vitest.config.mjs",
    test: {
      name: "@do-what/storage",
      include: ["packages/storage/src/__tests__/**/*.test.ts"]
    }
  }),
  defineProject({
    extends: "./vitest.config.mjs",
    test: {
      name: "@do-what/cli",
      environment: "node",
      include: ["bin/__tests__/**/*.test.mjs"]
    }
  }),
  defineProject({
    extends: "./vitest.config.mjs",
    test: {
      name: "@do-what/ui-sdk",
      environment: "jsdom",
      include: ["packages/ui-sdk/src/__tests__/**/*.test.ts"]
    }
  }),
  defineProject({
    extends: "./vitest.config.mjs",
    test: {
      name: "@do-what/surface-runtime",
      environment: "node",
      include: ["packages/surface-runtime/src/__tests__/**/*.{test,spec}.ts"]
    }
  }),
  defineProject({
    extends: "./vitest.config.mjs",
    test: {
      name: "@do-what/app",
      environment: "jsdom",
      globals: true,
      include: [
        "apps/app/src/__tests__/**/*.test.{ts,tsx}",
        "apps/app/src/components/**/__tests__/**/*.test.{ts,tsx}",
        "apps/app/src/hooks/__tests__/**/*.test.{ts,tsx}",
        "apps/app/src/view-models/__tests__/**/*.test.{ts,tsx}",
        "apps/app/src/state/__tests__/**/*.test.{ts,tsx}",
        "apps/app/src/context/__tests__/**/*.test.{ts,tsx}"
      ],
      setupFiles: ["apps/app/src/__tests__/setup.ts"]
    }
  })
]);
