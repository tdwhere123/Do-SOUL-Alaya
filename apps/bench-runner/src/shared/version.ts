import { execSync } from "node:child_process";
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

export const RECALL_PIPELINE_VERSION = "fusion-evidence-first-v3";

export interface BenchCommitResolution {
  readonly sha7: string;
  readonly source: "env" | "git" | "fallback";
  readonly unavailable: boolean;
}

export function resolveBenchRunnerVersion(): string {
  if (cachedVersion !== null) {
    return cachedVersion;
  }
  const pkgPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../package.json"
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

export function resolveBenchCommitSha7(
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  return resolveBenchCommitInfo(env).sha7;
}

export function resolveBenchCommitInfo(
  env: Readonly<Record<string, string | undefined>> = process.env,
  resolveFromGit: () => string = defaultResolveBenchCommitFromGit
): BenchCommitResolution {
  const fromEnv = env.BENCH_COMMIT_SHA7?.trim();
  if (fromEnv !== undefined && /^[0-9a-f]{7,40}$/iu.test(fromEnv)) {
    return {
      sha7: fromEnv.slice(0, 7),
      source: "env",
      unavailable: false
    };
  }
  try {
    return {
      sha7: resolveFromGit(),
      source: "git",
      unavailable: false
    };
  } catch {
    return {
      sha7: "0000000",
      source: "fallback",
      unavailable: true
    };
  }
}

function defaultResolveBenchCommitFromGit(): string {
  // git --short is adaptive (>= 7 chars when a 7-char prefix is ambiguous);
  // slice to the 7-char contract this function name and the env path above
  // both guarantee, so the result is always exactly 7 hex chars.
  return execSync("git rev-parse --short=7 HEAD", { encoding: "utf8" })
    .trim()
    .slice(0, 7);
}
