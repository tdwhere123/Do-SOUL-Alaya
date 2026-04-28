import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, defineProject } from "vitest/config";

export const rootDir = path.dirname(fileURLToPath(import.meta.url));

export const sharedAlias = {
  "@do-what/protocol": path.resolve(rootDir, "packages/protocol/src/index.ts"),
  "@do-what/core": path.resolve(rootDir, "packages/core/src/index.ts"),
  "@do-what/soul": path.resolve(rootDir, "packages/soul/src/index.ts"),
  "@do-what/engine-gateway": path.resolve(rootDir, "packages/engine-gateway/src/index.ts"),
  "@do-what/storage": path.resolve(rootDir, "packages/storage/src/index.ts"),
  "@do-what/ui-sdk": path.resolve(rootDir, "packages/ui-sdk/src/index.ts"),
  "@do-what/surface-runtime": path.resolve(rootDir, "packages/surface-runtime/src/index.ts")
};

export function appCoverageTargetComponents(repoRoot = rootDir) {
  return [
    "ApprovalCard",
    "CodeView",
    "Composer",
    "DirtyStateOverlay",
    "GovernanceSpamBanner",
    "IntegrationStatusBanner",
    "SecurityBanner",
    "Settings",
    "Shell",
    "Sidebar",
    "Soul",
    "Timeline",
    "ToolBlock",
    "WorkerCard"
  ].map((component) => (
    path.resolve(repoRoot, `apps/app/src/components/${component}/**/*.{ts,tsx}`)
  ));
}

export const appCoverageExcludes = [
  "**/__tests__/**",
  "**/index.ts"
];

export const appCoverageThresholds = {
  statements: 80,
  branches: 70,
  functions: 80,
  lines: 80
};

export function createAppProject(repoRoot = rootDir) {
  return defineProject({
    resolve: { alias: sharedAlias },
    test: {
      name: "@do-what/app",
      environment: "jsdom",
      globals: true,
      include: [
        path.resolve(repoRoot, "apps/app/src/__tests__/**/*.{test,spec}.{ts,tsx}"),
        path.resolve(repoRoot, "apps/app/src/view-models/__tests__/**/*.{test,spec}.{ts,tsx}"),
        path.resolve(repoRoot, "apps/app/src/hooks/__tests__/**/*.{test,spec}.{ts,tsx}"),
        path.resolve(repoRoot, "apps/app/src/components/**/__tests__/**/*.{test,spec}.{ts,tsx}"),
        path.resolve(repoRoot, "apps/app/src/context/__tests__/**/*.{test,spec}.{ts,tsx}"),
        path.resolve(repoRoot, "apps/app/src/state/__tests__/**/*.{test,spec}.{ts,tsx}")
      ],
      setupFiles: [path.resolve(repoRoot, "apps/app/src/__tests__/setup.ts")],
      exclude: ["**/dist/**"],
      coverage: {
        provider: "v8",
        include: appCoverageTargetComponents(repoRoot),
        exclude: appCoverageExcludes,
        thresholds: appCoverageThresholds
      }
    }
  });
}

export function createProtocolProject(repoRoot = rootDir) {
  return defineProject({
    resolve: { alias: sharedAlias },
    test: {
      name: "@do-what/protocol",
      environment: "node",
      include: [
        path.resolve(repoRoot, "packages/protocol/src/__tests__/**/*.{test,spec}.ts")
      ],
      exclude: ["**/dist/**"]
    }
  });
}

export function createSoulProject(repoRoot = rootDir) {
  return defineProject({
    resolve: { alias: sharedAlias },
    test: {
      name: "@do-what/soul",
      environment: "node",
      include: [
        path.resolve(repoRoot, "packages/soul/src/__tests__/**/*.{test,spec}.ts")
      ],
      exclude: ["**/dist/**"]
    }
  });
}

export function createStorageProject(repoRoot = rootDir) {
  return defineProject({
    resolve: { alias: sharedAlias },
    test: {
      name: "@do-what/storage",
      environment: "node",
      include: [
        path.resolve(repoRoot, "packages/storage/src/__tests__/**/*.{test,spec}.ts")
      ],
      exclude: ["**/dist/**"]
    }
  });
}

export function createCliProject(repoRoot = rootDir) {
  return defineProject({
    test: {
      name: "@do-what/cli",
      environment: "node",
      include: [
        path.resolve(repoRoot, "bin/__tests__/**/*.test.mjs")
      ],
      exclude: ["**/dist/**"]
    }
  });
}

export function createTuiProject(repoRoot = rootDir) {
  return defineProject({
    resolve: { alias: sharedAlias },
    test: {
      name: "@do-what/tui",
      environment: "node",
      include: [
        path.resolve(repoRoot, "apps/tui/src/__tests__/**/*.{test,spec}.{ts,tsx}")
      ],
      exclude: ["**/dist/**"]
    }
  });
}

export function createUiSdkProject(repoRoot = rootDir) {
  return defineProject({
    resolve: { alias: sharedAlias },
    test: {
      name: "@do-what/ui-sdk",
      environment: "node",
      include: [
        path.resolve(repoRoot, "packages/ui-sdk/src/__tests__/**/*.{test,spec}.ts")
      ],
      exclude: ["**/dist/**"]
    }
  });
}

export function createSurfaceRuntimeProject(repoRoot = rootDir) {
  return defineProject({
    resolve: { alias: sharedAlias },
    test: {
      name: "@do-what/surface-runtime",
      environment: "node",
      include: [
        path.resolve(repoRoot, "packages/surface-runtime/src/__tests__/**/*.{test,spec}.ts")
      ],
      exclude: ["**/dist/**"]
    }
  });
}

export function createCoreProject(repoRoot = rootDir) {
  return defineProject({
    resolve: { alias: sharedAlias },
    test: {
      name: "@do-what/core",
      environment: "node",
      include: [
        path.resolve(repoRoot, "packages/core/src/__tests__/**/*.{test,spec}.ts")
      ],
      exclude: ["**/dist/**"]
    }
  });
}

export function createEngineGatewayProject(repoRoot = rootDir) {
  return defineProject({
    resolve: { alias: sharedAlias },
    test: {
      name: "@do-what/engine-gateway",
      environment: "node",
      include: [
        path.resolve(repoRoot, "packages/engine-gateway/src/__tests__/**/*.{test,spec}.ts")
      ],
      exclude: ["**/dist/**"]
    }
  });
}

export function createCoreDaemonProject(repoRoot = rootDir) {
  return defineProject({
    resolve: { alias: sharedAlias },
    test: {
      name: "@do-what/core-daemon",
      environment: "node",
      include: [
        path.resolve(repoRoot, "apps/core-daemon/src/__tests__/**/*.{test,spec}.ts")
      ],
      exclude: ["**/dist/**"]
    }
  });
}

export default defineConfig({
  resolve: {
    alias: sharedAlias
  },
  test: {
    environment: "node",
    exclude: ["**/dist/**", "**/apps/app-legacy/**"],
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      include: appCoverageTargetComponents(rootDir),
      exclude: appCoverageExcludes,
      thresholds: appCoverageThresholds
    },
    projects: [
      createProtocolProject(rootDir),
      createSoulProject(rootDir),
      createStorageProject(rootDir),
      createCliProject(rootDir),
      createAppProject(rootDir),
      createTuiProject(rootDir),
      createUiSdkProject(rootDir),
      createSurfaceRuntimeProject(rootDir),
      createCoreProject(rootDir),
      createEngineGatewayProject(rootDir),
      createCoreDaemonProject(rootDir)
    ]
  }
});
