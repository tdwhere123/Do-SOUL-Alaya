import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import { afterEach, describe, expect, it } from "vitest";
import { runC0ReuseDecisionCommand } from "../../../cli/c0/command.js";
import { cacheFilePath } from "../../../longmemeval/compile-seed-cache.js";
import {
  EXTRACTION_CACHE_KEY_ALGO,
  computeSystemPromptSha256
} from "../../../longmemeval/extraction-cache-manifest.js";
import { readC0DecisionReceipt } from
  "../../../longmemeval/extraction/c0/decision-receipt.js";
import { buildC0OccurrenceIndex } from
  "../../../longmemeval/extraction/c0/occurrence-index.js";
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

describe("c0-reuse-decision command", () => {
  it("replays local cache only, records every evidence artifact, and forces a new root for unknown legacy semantics", async () => {
    const fixture = createFixture();
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runC0ReuseDecisionCommand(commandArgs(fixture), {
      now: () => "2026-07-17T00:00:00.000Z",
      writeStdout: (text) => stdout.push(text),
      writeStderr: (text) => stderr.push(text)
    });

    const receipt = readC0DecisionReceipt(join(fixture.evidenceRoot, "decision.json"));
    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("")).toContain("C0 decision=rebuild");
    expect(receipt.decision.reasons).toEqual(expect.arrayContaining([
      "parser_semantics_mismatch",
      "formation_semantics_mismatch",
      "temporal_schema_mismatch"
    ]));
    expect(existsSync(fixture.targetRoot)).toBe(false);
    expect(readFileSync(join(fixture.evidenceRoot, "source-manifest.json"), "utf8"))
      .toBe(fixture.manifestRaw);
    expect(existsSync(join(fixture.evidenceRoot, "raw-inventory.json"))).toBe(true);
    expect(existsSync(join(fixture.evidenceRoot, "occurrence-index.json"))).toBe(true);
    expect(existsSync(join(fixture.evidenceRoot, "replay-ledger.json"))).toBe(true);
  });

  it("refuses any scope other than the authorized offline 100Q replay", async () => {
    const errors: string[] = [];

    const code = await runC0ReuseDecisionCommand([
      "--variant", "s", "--offset", "0", "--limit", "99"
    ], { writeStderr: (text) => errors.push(text) });

    expect(code).toBe(2);
    expect(errors.join("")).toMatch(/0 through 99/u);
  });
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "alaya-c0-command-"));
  roots.push(root);
  const dataDir = join(root, "data");
  const pinnedMetaRoot = join(root, "pinned");
  const sourceRoot = join(root, "source-cache");
  const targetRoot = join(root, "new-cache");
  const evidenceRoot = join(root, "evidence");
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
  const occurrences = buildC0OccurrenceIndex({
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
  return { dataDir, pinnedMetaRoot, sourceRoot, targetRoot, evidenceRoot, manifestRaw };
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
    "--c0-target-cache-root", fixture.targetRoot,
    "--c0-evidence-root", fixture.evidenceRoot,
    "--c0-final-model", model,
    "--c0-final-model-family", family,
    "--c0-final-request-profile", requestProfile,
    "--c0-final-provider-url", providerUrl
  ];
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
