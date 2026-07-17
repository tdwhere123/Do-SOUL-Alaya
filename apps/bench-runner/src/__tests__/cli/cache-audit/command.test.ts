import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import { afterEach, describe, expect, it } from "vitest";
import { runAuditExtractionCacheCommand } from "../../../cli/cache-audit/command.js";
import { cacheFilePath } from "../../../longmemeval/compile-seed-cache.js";
import {
  EXTRACTION_CACHE_KEY_ALGO,
  computeSystemPromptSha256
} from "../../../longmemeval/extraction-cache-manifest.js";
import { readExtractionCacheAuditReceipt } from
  "../../../longmemeval/extraction/cache-audit/receipt.js";
import { buildExtractionOccurrenceIndex } from
  "../../../longmemeval/extraction/cache-audit/occurrence-index.js";
import { buildLongMemEvalFixtureQuestion } from
  "../../longmemeval/longmemeval-fixture.js";

const roots: string[] = [];
const model = "gpt-5.4-mini";
const family = "gpt-5.4";
const requestProfile = "provider-default-v1" as const;
const providerUrl = "https://provider.example/v1";

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("audit-extraction-cache command", () => {
  it("records the audit and rebuilds when execution semantics were not recorded", async () => {
    const fixture = createFixture();
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runAuditExtractionCacheCommand(commandArgs(fixture), {
      now: () => "2026-07-17T00:00:00.000Z",
      writeStdout: (text) => stdout.push(text),
      writeStderr: (text) => stderr.push(text)
    });

    const receipt = readExtractionCacheAuditReceipt(
      join(fixture.auditOutput, "audit-receipt.json")
    );
    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("")).toContain("Extraction cache compatibility=rebuild");
    expect(receipt.kind).toBe("longmemeval_extraction_cache_compatibility_decision");
    expect(receipt.decision.reasons).toEqual(expect.arrayContaining([
      "parser_semantics_mismatch",
      "formation_semantics_mismatch",
      "temporal_schema_mismatch"
    ]));
    expect(existsSync(fixture.targetRoot)).toBe(false);
    expect(readFileSync(join(fixture.auditOutput, "source-manifest.json"), "utf8"))
      .toBe(fixture.manifestRaw);
    expect(existsSync(join(fixture.auditOutput, "raw-inventory.json"))).toBe(true);
    expect(existsSync(join(fixture.auditOutput, "occurrence-index.json"))).toBe(true);
    expect(existsSync(join(fixture.auditOutput, "replay-ledger.json"))).toBe(true);
  });

  it("refuses any scope other than the authorized offline 100Q replay", async () => {
    const errors: string[] = [];

    const code = await runAuditExtractionCacheCommand([
      "--variant", "s", "--offset", "0", "--limit", "99"
    ], { writeStderr: (text) => errors.push(text) });

    expect(code).toBe(2);
    expect(errors.join("")).toMatch(/0 through 99/u);
  });

  it("canonicalizes an intermediate symlink before checking root overlap", async () => {
    const fixture = createFixture();
    const nested = join(fixture.sourceRoot, "nested");
    const sourceAlias = join(fixture.root, "source-alias");
    mkdirSync(nested);
    symlinkSync(fixture.sourceRoot, sourceAlias, "dir");
    const args = commandArgs(fixture);
    args[args.indexOf("--cache-audit-output") + 1] = join(sourceAlias, "nested", "audit");
    const errors: string[] = [];

    const code = await runAuditExtractionCacheCommand(args, {
      writeStderr: (text) => errors.push(text)
    });

    expect(code).toBe(2);
    expect(errors.join("")).toMatch(/must not overlap/iu);
    expect(existsSync(join(nested, "audit"))).toBe(false);
  });
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "alaya-cache-audit-command-"));
  roots.push(root);
  const dataDir = join(root, "data");
  const pinnedMetaRoot = join(root, "pinned");
  const sourceRoot = join(root, "source-cache");
  const targetRoot = join(root, "new-cache");
  const auditOutput = join(root, "audit-output");
  mkdirSync(dataDir);
  mkdirSync(pinnedMetaRoot);
  mkdirSync(sourceRoot);
  const questions = Array.from({ length: 100 }, (_, index) =>
    buildLongMemEvalFixtureQuestion(`q-${String(index).padStart(3, "0")}`, `session-${index}`)
  );
  const datasetRaw = JSON.stringify(questions);
  const datasetSha256 = hash(datasetRaw);
  writeFileSync(join(dataDir, "longmemeval_s.json"), datasetRaw, "utf8");
  writeFileSync(join(pinnedMetaRoot, "longmemeval_s.meta.json"), JSON.stringify({
    name: "longmemeval_s", sha256: datasetSha256, question_count: questions.length
  }), "utf8");
  const occurrences = buildExtractionOccurrenceIndex({
    questions, model, requestProfile, systemPrompt: OFFICIAL_API_SYSTEM_PROMPT
  });
  for (const occurrence of occurrences) writeShard(sourceRoot, occurrence.cacheKey);
  const manifestRaw = `${JSON.stringify({
    schema_version: 3,
    extraction_model: model,
    model_family: family,
    request_profile: requestProfile,
    provider_url: providerUrl,
    system_prompt_sha256: computeSystemPromptSha256(OFFICIAL_API_SYSTEM_PROMPT),
    cache_key_algo: EXTRACTION_CACHE_KEY_ALGO,
    dataset: "longmemeval-s",
    dataset_revision: datasetSha256,
    storage: "git-tracked",
    built_at: "2026-07-17T00:00:00.000Z",
    builder: "test"
  }, null, 2)}\n`;
  writeFileSync(join(sourceRoot, "manifest.json"), manifestRaw, "utf8");
  return { root, dataDir, pinnedMetaRoot, sourceRoot, targetRoot, auditOutput, manifestRaw };
}

function writeShard(cacheRoot: string, cacheKey: string): void {
  const path = cacheFilePath(cacheRoot, cacheKey);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({
    cache_key: cacheKey,
    model,
    request_profile: requestProfile,
    raw_json: JSON.stringify({ signals: [] })
  }), "utf8");
}

function commandArgs(fixture: ReturnType<typeof createFixture>): string[] {
  return [
    "--variant", "s", "--offset", "0", "--limit", "100",
    "--data-dir", fixture.dataDir,
    "--pinned-meta-root", fixture.pinnedMetaRoot,
    "--extraction-cache-root", fixture.sourceRoot,
    "--rebuild-cache-root", fixture.targetRoot,
    "--cache-audit-output", fixture.auditOutput,
    "--target-model", model,
    "--target-model-family", family,
    "--target-request-profile", requestProfile,
    "--target-provider-url", providerUrl
  ];
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
