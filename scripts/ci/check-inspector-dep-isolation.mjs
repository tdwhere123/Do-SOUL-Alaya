#!/usr/bin/env node
// Inspector SPA deps (React/Vite) must stay in apps/inspector/web only — not in
// daemon hot-path packages that ship to CLI/MCP runtime.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const INSPECTOR_WEB_ONLY = new Set([
  "react",
  "react-dom",
  "vite",
  "@vitejs/plugin-react",
  "react-router-dom",
  "react-force-graph-2d",
  "react-force-graph-3d",
  "lucide-react",
  "@testing-library/react",
  "jsdom"
]);

const HOT_PATH_MANIFESTS = [
  "apps/core-daemon/package.json",
  "apps/bench-runner/package.json",
  "apps/inspector/package.json",
  "packages/core/package.json",
  "packages/storage/package.json",
  "packages/soul/package.json",
  "packages/engine-gateway/package.json",
  "packages/protocol/package.json",
  "packages/eval/package.json",
  "packages/graph-algorithms/package.json",
  "packages/cjk-segmentation/package.json"
];

const violations = [];

for (const rel of HOT_PATH_MANIFESTS) {
  const abs = path.join(repoRoot, rel);
  const pkg = JSON.parse(readFileSync(abs, "utf8"));
  const sections = ["dependencies", "devDependencies", "optionalDependencies"];
  for (const section of sections) {
    const deps = pkg[section];
    if (!deps) {
      continue;
    }
    for (const name of Object.keys(deps)) {
      if (INSPECTOR_WEB_ONLY.has(name)) {
        violations.push(`${rel} ${section} -> ${name}`);
      }
    }
  }
}

if (violations.length > 0) {
  console.error("Inspector SPA dependencies leaked into hot-path packages:");
  for (const line of violations) {
    console.error(`  - ${line}`);
  }
  process.exit(1);
}

const protocolPkg = JSON.parse(
  readFileSync(path.join(repoRoot, "packages/protocol/package.json"), "utf8")
);
const protocolDeps = Object.keys(protocolPkg.dependencies ?? {});
if (protocolDeps.length !== 1 || protocolDeps[0] !== "zod") {
  console.error(
    `protocol dependencies must be exactly zod (invariant 1); got ${JSON.stringify(protocolDeps)}`
  );
  process.exit(1);
}

const inspectorWebPkg = JSON.parse(
  readFileSync(path.join(repoRoot, "apps/inspector/web/package.json"), "utf8")
);
const inspectorWebDeps = {
  ...(inspectorWebPkg.dependencies ?? {}),
  ...(inspectorWebPkg.devDependencies ?? {})
};
if (
  inspectorWebDeps["@node-rs/jieba"] !== undefined ||
  inspectorWebDeps["@do-soul/alaya-cjk-segmentation"] !== undefined
) {
  console.error("Inspector SPA must not depend on native CJK segmentation");
  process.exit(1);
}

console.log("check-inspector-dep-isolation: ok (React/Vite deps confined to apps/inspector/web; protocol zod-only)");
