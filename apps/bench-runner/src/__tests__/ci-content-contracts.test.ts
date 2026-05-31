import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { execFileWithFileCapture } from "./script-capture";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../.."
);
const scriptPath = path.join(repoRoot, "scripts/ci/check-content-contracts.mjs");

describe("CI bench-history content contracts", () => {
  it("allows a degraded archive to advance latest-run only", async () => {
    const historyRoot = await createHistoryRoot();
    await writeArchive(historyRoot, {
      benchName: "public",
      slug: "2026-05-31T003312Z-5fd0836-policy-stress",
      withFindings: true,
      seedPath: "no_credentials_fallback",
      pointerFiles: ["latest-run.json"]
    });

    await expect(runContract(historyRoot)).resolves.toMatchObject({
      stdout: expect.stringContaining("bench-history content contracts OK")
    });
  });

  it("rejects a degraded archive that advances latest-passing", async () => {
    const historyRoot = await createHistoryRoot();
    await writeArchive(historyRoot, {
      benchName: "public",
      slug: "2026-05-31T003312Z-5fd0836-policy-stress",
      withFindings: true,
      seedPath: "no_credentials_fallback",
      pointerFiles: ["latest-run.json", "latest-passing.json"]
    });

    await expect(runContract(historyRoot)).rejects.toMatchObject({
      stderr: expect.stringContaining("latest-passing.json"),
      code: 1
    });
  });

  it("rejects tracked full diagnostics in bench-history archives", async () => {
    const historyRoot = await createHistoryRoot();
    const slug = "2026-05-31T003312Z-5fd0836-policy-stress";
    await writeArchive(historyRoot, {
      benchName: "public",
      slug,
      withFindings: false,
      seedPath: "official_api_compile",
      pointerFiles: ["latest-run.json"]
    });
    await writeJson(
      path.join(historyRoot, "public", slug, "longmemeval-diagnostics.json"),
      { schema_version: 1, questions: [{ id: "q1" }] }
    );

    await expect(runContract(historyRoot)).rejects.toMatchObject({
      stderr: expect.stringContaining("tracked full diagnostics"),
      code: 1
    });
  });
});

async function createHistoryRoot(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "alaya-ci-content-"));
}

async function runContract(historyRoot: string) {
  return await execFileWithFileCapture(process.execPath, [scriptPath, "--history-root", historyRoot], {
    env: cliScriptEnv()
  });
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

interface ArchiveOptions {
  readonly benchName: string;
  readonly slug: string;
  readonly withFindings: boolean;
  readonly seedPath: "official_api_compile" | "no_credentials_fallback";
  readonly pointerFiles: readonly string[];
}

async function writeArchive(historyRoot: string, options: ArchiveOptions): Promise<void> {
  const benchRoot = path.join(historyRoot, options.benchName);
  const archiveRoot = path.join(benchRoot, options.slug);
  await mkdir(archiveRoot, { recursive: true });
  await writeJson(path.join(archiveRoot, "kpi.json"), {
    bench_name: options.benchName,
    split: "longmemeval-s",
    run_at: "2026-05-31T00:33:12.573Z",
    alaya_commit: "5fd0836",
    alaya_version: "0.3.11",
    embedding_provider: "none",
    sample_size: 500,
    evaluated_count: 500,
    kpi: {
      r_at_5: 0.95,
      latency_ms_p95: 150,
      seed_extraction_path: {
        path: options.seedPath,
        cache_hits: options.seedPath === "official_api_compile" ? 10 : 0,
        llm_calls: options.seedPath === "official_api_compile" ? 10 : 0,
        offline_fallbacks: options.seedPath === "official_api_compile" ? 0 : 8,
        live_extraction_failures: 0,
        cached_extraction_failures: 0,
        facts_produced: 20,
        signals_dropped: 0,
        parse_dropped: 0,
        compile_overflow_dropped: 0
      },
      recall_token_economy: {
        sample_count: 500
      }
    }
  });
  await writeFile(path.join(archiveRoot, "report.md"), "# Report\n", "utf8");
  if (options.withFindings) {
    await writeFile(
      path.join(archiveRoot, "findings.md"),
      "seed_extraction_path no_credentials_fallback\n",
      "utf8"
    );
  }
  for (const pointerFile of options.pointerFiles) {
    await writeJson(path.join(benchRoot, pointerFile), {
      slug: options.slug,
      kpi_path: `${options.slug}/kpi.json`
    });
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
