import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileWithFileCapture } from "./script-capture.js";
import { pathIsStrictlyOutside, pathsEqual } from "../support/test-paths.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");

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
    const result = await execFileWithFileCapture(
      process.execPath,
      [
        scriptPath,
        "--history-root",
        historyRoot,
        "--bench",
        "public",
        "--backlog",
        backlogPath,
        "--threshold-pp",
        "5"
      ],
      { env: cliScriptEnv() }
    );

    expect(JSON.parse(result.stdout)).toMatchObject({
      action: "opened",
      slug: failingSlug
    });
    const updated = await readFile(backlogPath, "utf8");
    expect(updated).toContain(`bench-degradation:auto public/${failingSlug}`);
    expect(updated).not.toContain(`bench-degradation:auto public/${passingSlug}`);
    expect(updated).toContain(path.join(historyRoot, "public", failingSlug));
  });

  it("initializes the backlog inside the selected history root and preserves the failure archive", async () => {
    const historyRoot = path.join(tmpDir, "local-history");
    const slug = "2026-05-15T080000Z-0bbbbbb";
    const archive = path.join(historyRoot, "public", slug);
    await mkdir(archive, { recursive: true });
    await writeFile(path.join(archive, "kpi.json"), JSON.stringify({ diff_vs_previous: { r_at_5_delta_pp: -12 }, kpi: {} }));
    await writeFile(path.join(archive, "findings.md"), "Preserve this failure.\n");
    await writeFile(path.join(historyRoot, "public", "latest-run.json"), JSON.stringify({ slug, kpi_path: `${slug}/kpi.json` }));
    const args = [path.join(repoRoot, "scripts/append-bench-degradation-backlog.mjs"), "--history-root", historyRoot];
    const first = await execFileWithFileCapture(process.execPath, args, { env: cliScriptEnv() });
    expect(JSON.parse(first.stdout)).toMatchObject({ action: "opened", issue: "#BL-001" });
    const backlogPath = path.join(historyRoot, "degradation-backlog.md");
    const backlog = await readFile(backlogPath, "utf8");
    expect(backlog).toContain(archive);
    expect(backlog).toContain("**Next available number**: `#BL-002`");
    const second = await execFileWithFileCapture(process.execPath, args, { env: cliScriptEnv() });
    expect(JSON.parse(second.stdout)).toMatchObject({ action: "noop", reason: "already_recorded" });
    expect(await readFile(backlogPath, "utf8")).toBe(backlog);
    expect(await readFile(path.join(archive, "findings.md"), "utf8")).toBe("Preserve this failure.\n");
  });

  it("resolves orchestrator defaults locally and checks the explicit cache before any bench spawn", async () => {
    const script = path.join(repoRoot, "scripts/run-full-bench-v0311.mjs");
    const envCache = path.join(tmpDir, "environment-cache");
    const explicitCache = path.join(tmpDir, "explicit-cache");
    await mkdir(envCache);
    await mkdir(explicitCache);
    await writeFile(path.join(envCache, "manifest.json"), JSON.stringify({ extraction_model: "environment-model" }));
    await writeFile(path.join(explicitCache, "manifest.json"), JSON.stringify({ extraction_model: "explicit-model" }));
    const env = { ...cliScriptEnv(), ALAYA_BENCH_EXTRACTION_CACHE_ROOT: envCache, OFFICIAL_API_GARDEN_MODEL: "blocked-model" };
    const dryRun = await execFileWithFileCapture(process.execPath, [script, "--dry-run", "--log-root", path.join(tmpDir, "logs")], { env });
    expect(dryRun.stdout).toContain(`history_root=${path.join(repoRoot, ".bench-artifacts", "history")}`);
    expect(dryRun.stdout).toContain(`extraction_cache_root=${envCache}`);
    const selected = await execFileRejects(process.execPath, [script, "--extraction-cache-root", explicitCache], env);
    expect(selected.code).toBe(2);
    expect(selected.stderr).toContain("manifest model explicit-model");
    expect(selected.stderr).not.toContain("manifest model environment-model");
    const missing = path.join(tmpDir, "missing-cache");
    const absent = await execFileRejects(process.execPath, [script, "--extraction-cache-root", missing], env);
    expect(absent.code).toBe(2);
    expect(absent.stderr).toContain(`selected extraction cache manifest is missing: ${path.join(missing, "manifest.json")}`);
  });

  it("reuses only a matching completed-run checkpoint and blocks a changed request without spawning a bench", async () => {
    const script = path.join(repoRoot, "scripts/run-full-bench-v0311.mjs");
    const dataDir = path.join(tmpDir, "data");
    const historyRoot = path.join(tmpDir, "history");
    const logRoot = path.join(tmpDir, "logs");
    const cacheRoot = path.join(tmpDir, "cache");
    const spawnLog = path.join(tmpDir, "bench-spawns.log");
    await mkdir(path.join(dataDir, "longmemeval"), { recursive: true });
    await mkdir(cacheRoot);
    await writeFile(
      path.join(cacheRoot, "manifest.json"),
      JSON.stringify({ extraction_model: "checkpoint-model" })
    );
    const preloadPath = path.join(tmpDir, "fake-bench-runner.cjs");
    await writeFile(
      preloadPath,
      [
        "\"use strict\";",
        "const { appendFileSync, mkdirSync, writeFileSync } = require(\"node:fs\");",
        "const path = require(\"node:path\");",
        "if ((process.argv[1] ?? \"\").endsWith(\"alaya-bench-runner.mjs\")) {",
        `  appendFileSync(${JSON.stringify(spawnLog)}, "spawn\\n");`,
        "  const argv = process.argv.slice(2);",
        "  const historyRoot = argv[argv.indexOf(\"--history-root\") + 1];",
        "  const archive = path.join(historyRoot, \"public\", \"2099-01-01T000000Z-abcdef0-policy-chat\");",
        "  mkdirSync(archive, { recursive: true });",
        "  writeFileSync(path.join(archive, \"kpi.json\"), \"{}\\n\");",
        "  process.exit(0);",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );
    const env = {
      ...cliScriptEnv(),
      OFFICIAL_API_GARDEN_MODEL: "checkpoint-model",
      NODE_OPTIONS: `--require=${preloadPath}`
    };
    const runArgs = [
      script,
      "--bench", "lme-s",
      "--limit", "1",
      "--data-dir", dataDir,
      "--history-root", historyRoot,
      "--log-root", logRoot,
      "--extraction-cache-root", cacheRoot
    ];

    const completed = await execFileWithFileCapture(process.execPath, runArgs, { env });
    expect(completed.stdout).toContain("lme-s: OK");
    expect(await readFile(spawnLog, "utf8")).toBe("spawn\n");

    const resumed = await execFileWithFileCapture(
      process.execPath,
      [...runArgs, "--resume"],
      { env }
    );
    expect(resumed.stdout).toContain("SKIP (resume checkpoint matches");
    expect(await readFile(spawnLog, "utf8")).toBe("spawn\n");

    const changed = await execFileRejects(
      process.execPath,
      [
        script,
        "--bench", "lme-s",
        "--limit", "2",
        "--data-dir", dataDir,
        "--history-root", historyRoot,
        "--log-root", logRoot,
        "--extraction-cache-root", cacheRoot,
        "--resume"
      ],
      env
    );
    expect(changed.code).toBe(1);
    expect(changed.stderr).toContain("checkpoint is not reusable");
    expect(changed.stderr).toContain("limit recorded=1 requested=2");
    expect(changed.stderr).toContain("No bench was started");
    expect(await readFile(spawnLog, "utf8")).toBe("spawn\n");
  });

  it("forwards the shared default history root through the daily wrapper without starting a bench", async () => {
    const markerPath = path.join(tmpDir, "forwarded.json");
    const intercept = path.join(tmpDir, "capture.cjs");
    await writeFile(intercept, `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify(process.argv.slice(2))); process.exit(0);`);
    await execFileWithFileCapture("bash", [path.join(repoRoot, "apps/bench-runner/scripts/run-daily-public-bench.sh")], {
      env: { ...cliScriptEnv(), BENCH_NODE_BIN: process.execPath.replaceAll("\\", "/"), BENCH_NODE_INTERCEPT: intercept.replaceAll("\\", "/"),
        BENCH_DAILY_HISTORY_ROOT: "", BENCH_DAILY_EMBEDDINGS: "disabled", BENCH_DAILY_POLICY_SHAPES: "stress",
        BENCH_LOG_DIR: path.join(tmpDir, "logs").replaceAll("\\", "/") }
    });
    const forwarded = JSON.parse(await readFile(markerPath, "utf8")) as string[];
    expect(forwarded[forwarded.indexOf("--history-root") + 1]).toBe(path.join(repoRoot, ".bench-artifacts", "history"));
  });

  it("keeps local ONNX default cache fallback outside the current working tree", async () => {
    const { defaultCacheDir } = await import(
      path.resolve(repoRoot, "scripts/local-embedding-cache-dir.mjs")
    );
    const checkoutRoot = path.join(tmpDir, "checkout");
    const fallbackTmp = path.join(tmpDir, "tmp");

    const cacheDir = defaultCacheDir({}, "", fallbackTmp);
    const expected = path.join(fallbackTmp, "do-soul-alaya-cache", "do-soul-alaya", "models");

    expect(pathsEqual(cacheDir, expected)).toBe(true);
    expect(pathIsStrictlyOutside(checkoutRoot, cacheDir)).toBe(true);
  });

  it("loads the local embedding fetch script before validating arguments", async () => {
    const scriptPath = path.resolve(repoRoot, "scripts/fetch-local-embedding-model.mjs");

    const result = await execFileRejects(
      process.execPath,
      [scriptPath, "--unknown"],
      cliScriptEnv()
    );

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("unknown argument: --unknown");
    expect(result.stderr).not.toContain("ReferenceError");
  });

  it("does not append degradation backlog after daily runner infrastructure failures", async () => {
    const markerPath = path.join(tmpDir, "append-called");
    const scriptPath = path.resolve(
      repoRoot,
      "apps/bench-runner/scripts/run-daily-public-bench.sh"
    );
    const interceptPath = await writeFakeNodeBin(2, markerPath);

    const result = await execFileRejects("bash", [scriptPath], {
      ...cliScriptEnv(),
      BENCH_NODE_BIN: process.execPath.replaceAll("\\", "/"),
      BENCH_NODE_INTERCEPT: interceptPath.replaceAll("\\", "/"),
      BENCH_DAILY_EMBEDDINGS: "disabled",
      BENCH_DAILY_POLICY_SHAPES: "stress",
      BENCH_DAILY_LIMIT: "1",
      BENCH_DAILY_HISTORY_ROOT: path.join(tmpDir, "history").replaceAll("\\", "/"),
      BENCH_LOG_DIR: path.join(tmpDir, "logs").replaceAll("\\", "/")
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
    const interceptPath = await writeFakeNodeBin(1, markerPath);

    const result = await execFileRejects("bash", [scriptPath], {
      ...cliScriptEnv(),
      BENCH_NODE_BIN: process.execPath.replaceAll("\\", "/"),
      BENCH_NODE_INTERCEPT: interceptPath.replaceAll("\\", "/"),
      BENCH_DAILY_EMBEDDINGS: "disabled",
      BENCH_DAILY_POLICY_SHAPES: "stress",
      BENCH_DAILY_LIMIT: "1",
      BENCH_DAILY_HISTORY_ROOT: path.join(tmpDir, "history").replaceAll("\\", "/"),
      BENCH_LOG_DIR: path.join(tmpDir, "logs").replaceAll("\\", "/")
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
  const interceptPath = path.join(binDir, "node-intercept.cjs");
  await writeFile(
    interceptPath,
    [
      "\"use strict\";",
      "const { writeFileSync } = require(\"fs\");",
      "const target = process.argv[2] ?? \"\";",
      `if (target.includes("alaya-bench-runner.mjs")) process.exit(${benchExitCode});`,
      "if (target.includes(\"append-bench-degradation-backlog.mjs\")) {",
      `  writeFileSync(${JSON.stringify(appendMarkerPath)}, "called\\n");`,
      "  process.exit(0);",
      "}",
      "process.stderr.write(`unexpected node target: ${target}\\n`);",
      "process.exit(99);",
      ""
    ].join("\n"),
    "utf8"
  );
  return interceptPath;
}

function cliScriptEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("npm_") || key.startsWith("VITEST")) {
      delete env[key];
    }
  }
  delete env.NODE_OPTIONS;
  return env;
}

async function execFileRejects(
  file: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv
): Promise<{ readonly code: number | string | null; readonly stderr: string }> {
  try {
    await execFileAsync(file, args, { env });
  } catch (error) {
    const failed = error as { code?: number | string; stderr?: string | Buffer };
    return {
      code: failed.code ?? null,
      stderr: typeof failed.stderr === "string" ? failed.stderr : failed.stderr?.toString() ?? ""
    };
  }
  throw new Error("expected command to fail");
}
