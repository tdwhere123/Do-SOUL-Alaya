import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), "bench-scripts-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("bench maintenance scripts", () => {
  it("opens backlog entries from latest-run instead of the legacy latest-baseline pointer", async () => {
    const historyRoot = path.join(tmpDir, "history");
    const benchRoot = path.join(historyRoot, "public");
    const passingSlug = "2026-05-14T080000Z-0aaaaaa";
    const failingSlug = "2026-05-15T080000Z-0bbbbbb";
    await mkdir(path.join(benchRoot, passingSlug), { recursive: true });
    await mkdir(path.join(benchRoot, failingSlug), { recursive: true });
    await writeFile(
      path.join(benchRoot, passingSlug, "kpi.json"),
      JSON.stringify({ diff_vs_previous: { r_at_5_delta_pp: 0 }, kpi: {} }),
      "utf8"
    );
    await writeFile(
      path.join(benchRoot, failingSlug, "kpi.json"),
      JSON.stringify({
        diff_vs_previous: {
          r_at_5_delta_pp: -12,
          previous_run: passingSlug
        },
        kpi: {}
      }),
      "utf8"
    );
    await writeFile(
      path.join(benchRoot, "latest-baseline.json"),
      JSON.stringify({ slug: passingSlug, kpi_path: `${passingSlug}/kpi.json` }),
      "utf8"
    );
    await writeFile(
      path.join(benchRoot, "latest-run.json"),
      JSON.stringify({ slug: failingSlug, kpi_path: `${failingSlug}/kpi.json` }),
      "utf8"
    );

    const backlogPath = path.join(tmpDir, "backlog.md");
    await writeFile(
      backlogPath,
      [
        "# Backlog",
        "",
        "**Next available number**: `#BL-047`",
        "",
        "## Open Issues",
        "",
        "No open `#BL-*` issues at this time.",
        ""
      ].join("\n"),
      "utf8"
    );

    const scriptPath = path.resolve(
      repoRoot,
      "scripts/append-bench-degradation-backlog.mjs"
    );
    const result = await execFileAsync(process.execPath, [
      scriptPath,
      "--history-root",
      historyRoot,
      "--bench",
      "public",
      "--backlog",
      backlogPath,
      "--threshold-pp",
      "5"
    ]);

    expect(JSON.parse(result.stdout)).toMatchObject({
      action: "opened",
      slug: failingSlug
    });
    const updated = await readFile(backlogPath, "utf8");
    expect(updated).toContain(`bench-degradation:auto public/${failingSlug}`);
    expect(updated).not.toContain(`bench-degradation:auto public/${passingSlug}`);
  });

  it("keeps local ONNX default cache fallback outside the current working tree", async () => {
    const scriptUrl = pathToFileURL(
      path.resolve(repoRoot, "scripts/fetch-local-embedding-model.mjs")
    ).href;
    const { defaultCacheDir } = (await import(scriptUrl)) as {
      readonly defaultCacheDir: (
        env: Record<string, string | undefined>,
        fallbackHome: string,
        fallbackTmp: string
      ) => string;
    };
    const repoLikeCwd = path.join(tmpDir, "checkout");
    const fallbackTmp = path.join(tmpDir, "tmp");

    const cacheDir = defaultCacheDir({}, "", fallbackTmp);

    expect(cacheDir).toBe(path.join(fallbackTmp, "do-soul-alaya-cache", "do-soul-alaya/models"));
    expect(cacheDir.startsWith(repoLikeCwd)).toBe(false);
  });

  it("does not append degradation backlog after daily runner infrastructure failures", async () => {
    const markerPath = path.join(tmpDir, "append-called");
    const scriptPath = path.resolve(
      repoRoot,
      "apps/bench-runner/scripts/run-daily-public-bench.sh"
    );
    const fakeBin = await writeFakeNodeBin(2, markerPath);

    const result = await execFileRejects("bash", [scriptPath], {
      ...process.env,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
      BENCH_DAILY_EMBEDDINGS: "disabled",
      BENCH_DAILY_POLICY_SHAPES: "stress",
      BENCH_DAILY_LIMIT: "1",
      BENCH_DAILY_HISTORY_ROOT: path.join(tmpDir, "history"),
      BENCH_LOG_DIR: path.join(tmpDir, "logs")
    });

    expect(result.code).toBe(2);
    await expect(access(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("appends degradation backlog after daily hard-gate failures", async () => {
    const markerPath = path.join(tmpDir, "append-called");
    const scriptPath = path.resolve(
      repoRoot,
      "apps/bench-runner/scripts/run-daily-public-bench.sh"
    );
    const fakeBin = await writeFakeNodeBin(1, markerPath);

    const result = await execFileRejects("bash", [scriptPath], {
      ...process.env,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
      BENCH_DAILY_EMBEDDINGS: "disabled",
      BENCH_DAILY_POLICY_SHAPES: "stress",
      BENCH_DAILY_LIMIT: "1",
      BENCH_DAILY_HISTORY_ROOT: path.join(tmpDir, "history"),
      BENCH_LOG_DIR: path.join(tmpDir, "logs")
    });

    expect(result.code).toBe(1);
    expect(await readFile(markerPath, "utf8")).toBe("called\n");
  });
});

async function writeFakeNodeBin(
  benchExitCode: number,
  appendMarkerPath: string
): Promise<string> {
  const binDir = path.join(tmpDir, "fake-bin");
  await mkdir(binDir, { recursive: true });
  const fakeNodePath = path.join(binDir, "node");
  await writeFile(
    fakeNodePath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "case \"$1\" in",
      "  apps/bench-runner/bin/alaya-bench-runner.mjs)",
      `    exit ${benchExitCode}`,
      "    ;;",
      "  scripts/append-bench-degradation-backlog.mjs)",
      `    printf 'called\\n' > ${JSON.stringify(appendMarkerPath)}`,
      "    exit 0",
      "    ;;",
      "  *)",
      "    echo \"unexpected node target: $1\" >&2",
      "    exit 99",
      "    ;;",
      "esac",
      ""
    ].join("\n"),
    "utf8"
  );
  await chmod(fakeNodePath, 0o755);
  return binDir;
}

async function execFileRejects(
  file: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv
): Promise<{ readonly code: number | string | null }> {
  try {
    await execFileAsync(file, args, { env });
  } catch (error) {
    return { code: (error as { code?: number | string }).code ?? null };
  }
  throw new Error("expected command to fail");
}
