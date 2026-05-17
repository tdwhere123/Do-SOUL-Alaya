import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// invariant: single source of truth for the bench-runner package
// version. Every bench archive (kpi.json + report.md) and the MCP
// client identification line read from here so a release bump
// propagates everywhere automatically. Fail-closed: read failure
// throws rather than silently falling back to a stale literal which
// would mis-attribute every archive after the next bump.
// see also: apps/bench-runner/package.json
let cachedVersion: string | null = null;

export function resolveBenchRunnerVersion(): string {
  if (cachedVersion !== null) {
    return cachedVersion;
  }
  const pkgPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../package.json"
  );
  const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error(
      `apps/bench-runner/package.json at ${pkgPath} has no usable version string`
    );
  }
  cachedVersion = parsed.version;
  return cachedVersion;
}
