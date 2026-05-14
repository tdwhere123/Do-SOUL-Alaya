import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

const sharedAlias = {
  "@do-soul/alaya-protocol": path.resolve(rootDir, "packages/protocol/src/index.ts"),
  "@do-soul/alaya-storage": path.resolve(rootDir, "packages/storage/src/index.ts"),
  "@do-soul/alaya-core": path.resolve(rootDir, "packages/core/src/index.ts"),
  "@do-soul/alaya-soul": path.resolve(rootDir, "packages/soul/src/index.ts"),
  "@do-soul/alaya-engine-gateway": path.resolve(rootDir, "packages/engine-gateway/src/index.ts")
};

function packageProject(name, packageDir) {
  const packageRoot = path.resolve(rootDir, packageDir);
  const testDir = path.resolve(rootDir, packageDir, "src/__tests__");
  if (!existsSync(path.resolve(packageRoot, "package.json"))) {
    return null;
  }

  return defineProject({
    resolve: {
      alias: sharedAlias
    },
    test: {
      name,
      environment: "node",
      include: [path.resolve(testDir, "**/*.{test,spec}.ts")],
      exclude: ["**/dist/**"]
    }
  });
}

function appProject(name, appDir) {
  const appRoot = path.resolve(rootDir, appDir);
  const testDir = path.resolve(rootDir, appDir, "src/__tests__");
  if (!existsSync(path.resolve(appRoot, "package.json"))) {
    return null;
  }

  return defineProject({
    resolve: {
      alias: sharedAlias
    },
    test: {
      name,
      environment: "node",
      include: [path.resolve(testDir, "**/*.{test,spec}.ts")],
      exclude: ["**/dist/**"]
    }
  });
}

export default [
  packageProject("@do-soul/alaya-protocol", "packages/protocol"),
  packageProject("@do-soul/alaya-storage", "packages/storage"),
  packageProject("@do-soul/alaya-core", "packages/core"),
  packageProject("@do-soul/alaya-soul", "packages/soul"),
  packageProject("@do-soul/alaya-engine-gateway", "packages/engine-gateway"),
  packageProject("@do-soul/alaya-eval", "packages/eval"),
  appProject("@do-soul/alaya-core-daemon", "apps/core-daemon"),
  appProject("@do-soul/alaya-inspector", "apps/inspector"),
  // The inspector web frontend has its own vitest config (jsdom env, RTL setup).
  // Reference its config file directly so the workspace runner picks it up.
  path.resolve(rootDir, "apps/inspector/web/vitest.config.ts")
].filter(Boolean);
