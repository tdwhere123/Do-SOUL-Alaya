import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  unlinkSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NeutralityBundle } from "./neutrality-shadow-fixture.js";
import { SHADOW_OFF_SHA } from "./neutrality-shadow-fixture.js";

const FIXTURE_NAMES = [
  "neutrality-shadow-fixture.ts",
  "neutrality-shadow-capture.test.ts"
] as const;

export function captureShadowOffBundle(): NeutralityBundle {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const shadowOffRoot = resolveShadowOffRoot(here);
  const destDir = path.join(
    shadowOffRoot,
    "packages/core/src/__tests__/recall"
  );
  const copied = copyCaptureFiles(here, destDir);
  const outFile = path.join(
    mkdtempSync(path.join(tmpdir(), "alaya-neutrality-")),
    "shadow-off.json"
  );
  try {
    runShadowOffVitest(shadowOffRoot, outFile);
    return JSON.parse(readFileSync(outFile, "utf8")) as NeutralityBundle;
  } finally {
    for (const file of copied) {
      unlinkSync(file);
    }
  }
}

export function resolveShadowOffRoot(from: string): string {
  const override = process.env.QUERY_PROOF_BASE_ROOT;
  if (override !== undefined && override.length > 0) {
    assertShadowOffHead(override);
    return override;
  }
  const top = git(["rev-parse", "--show-toplevel"], from);
  const common = git(["rev-parse", "--git-common-dir"], from);
  const gitDir = path.isAbsolute(common) ? common : path.resolve(top, common);
  const mainRoot = path.dirname(gitDir);
  assertShadowOffHead(mainRoot);
  if (path.resolve(mainRoot) === path.resolve(top)) {
    throw new Error(
      "shadow-off capture refused to overwrite the current worktree; set QUERY_PROOF_BASE_ROOT"
    );
  }
  return mainRoot;
}

function copyCaptureFiles(sourceDir: string, destDir: string): readonly string[] {
  return FIXTURE_NAMES.map((name) => {
    const dest = path.join(destDir, name);
    copyFileSync(path.join(sourceDir, name), dest);
    return dest;
  });
}

function runShadowOffVitest(root: string, outFile: string): void {
  execFileSync(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "--project",
      "@do-soul/alaya-core",
      "packages/core/src/__tests__/recall/neutrality-shadow-capture.test.ts"
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        NEUTRALITY_CAPTURE_OUT: outFile
      },
      timeout: 120_000
    }
  );
}

function assertShadowOffHead(root: string): void {
  const head = git(["rev-parse", "HEAD"], root);
  if (!head.startsWith(SHADOW_OFF_SHA.slice(0, 12))) {
    throw new Error(
      `shadow-off root ${root} HEAD is ${head}, expected ${SHADOW_OFF_SHA}`
    );
  }
}

function git(args: readonly string[], cwd: string): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();
}
