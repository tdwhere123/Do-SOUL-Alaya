import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  officialApiSemanticWorksetFromUnits,
  planOfficialApiSemanticWorkset,
  planOfficialApiTransport
} from "@do-soul/alaya-soul";
import { runExtractionFill, type ExtractionFillOptions } from
  "../../../runs/extraction/extraction-fill.js";
import { readExtractionCacheManifestIdentity } from
  "../../../runs/extraction/cache/extraction-cache-manifest.js";
import {
  inspectSemanticArtifact
} from "../../../runs/extraction/cache/semantic-artifact/store.js";
import type { BenchSignalExtractor } from "../../../runs/compile-seed.js";
import {
  buildExtractionFillQuestion as buildQuestion,
  buildGroundedSignalResponse,
  EXTRACTION_FILL_VARIANT as VARIANT,
  providerBackedExtractionResult,
  registerExtractionFillHooks
} from "./fixture.js";
import type { SemanticFillTask } from "../../../runs/extraction/fill/semantic-fill-executor.js";
import { createOfflineSemanticReplay } from
  "../../../runs/extraction/fill/semantic-fill-envelope.js";
import { collectSemanticFillTasks } from
  "../../../runs/extraction/fill/semantic-workset-tasks.js";
import { toWorkUnit } from "../../../runs/extraction/fill/semantic-fill-plan.js";
import { prepareExtractionFill } from
  "../../../runs/extraction/fill/fill-preparation.js";

let cacheRoot: string;
let dataDir: string;
let pinnedMetaRoot: string;
const writeFixtureDataset = registerExtractionFillHooks((roots) => {
  ({ cacheRoot, dataDir, pinnedMetaRoot } = roots);
});

const TOKEN_AWARE_POLICY = {
  kind: "token_aware" as const,
  maxAssertions: 32,
  maxInputTokens: 100_000,
  expectedOutputCap: 8_000,
  systemPromptChars: 0
};

async function sealedReplayForLazyWindow(
  window: Pick<ExtractionFillOptions, "limit" | "offset">,
  emptyMemberTexts: readonly string[] = []
) {
  const prepared = await prepareExtractionFill({
    variant: VARIANT,
    cacheRoot,
    dataDir,
    pinnedMetaRoot,
    ingestionMode: "lazy_field",
    log: () => undefined,
    ...window
  }, cacheRoot, 1, () => undefined, undefined);
  const tasks = collectSemanticFillTasks(prepared.executionExtractionTurns, prepared);
  if (tasks.length === 0) throw new Error("lazy overlay fixture produced no semantic demand");
  const byCorpus = new Map<string, SemanticFillTask[]>();
  for (const task of tasks) {
    const group = byCorpus.get(task.binding.sourceCorpusIdentity) ?? [];
    group.push(task);
    byCorpus.set(task.binding.sourceCorpusIdentity, group);
  }
  const results: Array<{
    readonly packId: string;
    readonly tasks: readonly SemanticFillTask[];
    readonly result: { readonly kind: "raw"; readonly rawJson: string };
  }> = [];
  for (const group of byCorpus.values()) {
    const plan = planOfficialApiTransport(
      officialApiSemanticWorksetFromUnits(group.map(toWorkUnit)),
      TOKEN_AWARE_POLICY
    );
    if (plan.unpackable.length > 0) {
      throw new Error("lazy overlay fixture produced unpackable semantic work");
    }
    for (const pack of plan.packs) {
      const members = pack.semantic_keys.map((key) => {
        const task = group.find((candidate) => candidate.semanticKey === key);
        if (task === undefined) throw new Error("lazy overlay fixture lost a semantic task");
        return task;
      });
      results.push({
        packId: pack.pack_id,
        tasks: members,
        result: { kind: "raw", rawJson: overlayRawJson(members, emptyMemberTexts) }
      });
    }
  }
  return createOfflineSemanticReplay({ results });
}

function overlayRawJson(
  members: readonly SemanticFillTask[],
  emptyMemberTexts: readonly string[] = []
): string {
  if (members.some((member) => emptyMemberTexts.some((text) => member.text.includes(text)))) {
    return '{"signals":[]}';
  }
  return JSON.stringify({
    signals: members.map((member) => ({
      object_kind: "fact",
      confidence: 0.9,
      matched_text: member.text.replace(/^(?:User|Assistant): /u, ""),
      source_locator: {
        contract_version: 2,
        kind: "assertion_catalog",
        assertion_id: member.assertionId
      }
    }))
  });
}

describe("runExtractionFill lazy_field success", () => {
  it("admits overlay artifacts without pinning or finishing v3", async () => {
    const question = buildQuestion("q001", "I moved to Berlin.", "I prefer TypeScript.");
    await writeFixtureDataset([question]);
    const complete = await runExtractionFill({
      variant: VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      extractorFactory: (): BenchSignalExtractor => ({
        extract: async (input) => providerBackedExtractionResult(
          buildGroundedSignalResponse(input.userPrompt)
        )
      }),
      log: () => undefined
    });
    expect(complete.manifest.fill_status).toBe("complete");
    const before = readExtractionCacheManifestIdentity(cacheRoot);
    if (before === undefined) throw new Error("expected complete v3 identity");

    const overlayRoot = join(cacheRoot, "..", "semantic-overlay");
    const overlay = await runExtractionFill({
      variant: VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      ingestionMode: "lazy_field",
      semanticArtifactRoot: overlayRoot,
      semanticTransport: await sealedReplayForLazyWindow({}),
      log: () => undefined
    });

    const after = readExtractionCacheManifestIdentity(cacheRoot);
    expect(after?.manifestSha256).toBe(before.manifestSha256);
    expect(after?.manifest.fill_status).toBe("complete");
    expect(overlay.manifest.fill_status).toBe("complete");
    expect(overlay.newlyExtracted).toBe(0);
    expect(overlay.semanticOverlayIdentity).toMatch(/^[a-f0-9]{64}$/u);
    expect(existsSync(join(cacheRoot, ".extraction-fill.lock"))).toBe(false);
    expect(existsSync(join(overlayRoot, ".extraction-fill.lock"))).toBe(false);

    const unit = planOfficialApiSemanticWorkset("I moved to Berlin.", [
      { role: "user", content: "I moved to Berlin." }
    ]).units[0];
    if (unit === undefined) throw new Error("expected minted workset unit");
    expect(inspectSemanticArtifact(
      overlayRoot,
      unit.semanticKey,
      "official_api_signals:v1"
    ).status).toBe("provider_backed");
  });

  it("runs a windowed lazy_field demand against a complete multi-question substrate", async () => {
    const first = buildQuestion("q001", "I moved to Berlin.", "I prefer TypeScript.");
    const second = buildQuestion("q002", "I moved to Paris.", "I prefer Rust.");
    await writeFixtureDataset([first, second]);
    const complete = await runExtractionFill({
      variant: VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      extractorFactory: (): BenchSignalExtractor => ({
        extract: async (input) => providerBackedExtractionResult(
          buildGroundedSignalResponse(input.userPrompt)
        )
      }),
      log: () => undefined
    });
    expect(complete.manifest.fill_status).toBe("complete");
    const expectedTurns = complete.manifest.expected_turns;
    if (expectedTurns === undefined) throw new Error("complete substrate lost expected_turns");

    const overlayRoot = join(cacheRoot, "..", "semantic-overlay-window");
    const overlay = await runExtractionFill({
      variant: VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      limit: 1,
      ingestionMode: "lazy_field",
      semanticArtifactRoot: overlayRoot,
      semanticTransport: await sealedReplayForLazyWindow({ limit: 1 }),
      log: () => undefined
    });
    const demandKeys = overlay.lazySemanticRunReceipt?.sourceAuthority.sourceCorpora
      .flatMap((entry) => entry.substrateCacheKeys) ?? [];
    expect(overlay.lazySemanticRunReceiptHandle).toBeDefined();
    expect(overlay.semanticOverlayIdentity).toMatch(/^[a-f0-9]{64}$/u);
    expect(overlay.coverage).toBe(complete.manifest.coverage);
    expect(demandKeys.length).toBeGreaterThan(0);
    expect(demandKeys.length).toBeLessThan(expectedTurns);
  });

  it("does not switch roots when the caller mutates fill options during await", async () => {
    const question = buildQuestion("q001", "I moved to Berlin.", "I prefer TypeScript.");
    await writeFixtureDataset([question]);
    await runExtractionFill({
      variant: VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      extractorFactory: (): BenchSignalExtractor => ({
        extract: async (input) => providerBackedExtractionResult(
          buildGroundedSignalResponse(input.userPrompt)
        )
      }),
      log: () => undefined
    });
    const overlayRoot = join(cacheRoot, "..", "semantic-overlay-frozen");
    const divertedRoot = join(cacheRoot, "nested-divert");
    const options = {
      variant: VARIANT as ExtractionFillOptions["variant"],
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      ingestionMode: "lazy_field" as const,
      semanticArtifactRoot: overlayRoot,
      semanticTransport: await sealedReplayForLazyWindow({}),
      log: () => undefined
    };
    const pending = runExtractionFill(options);
    (options as { semanticArtifactRoot: string }).semanticArtifactRoot = divertedRoot;
    (options as { ingestionMode?: string }).ingestionMode = "precomputed_full";
    const overlay = await pending;
    expect(overlay.lazySemanticRunReceipt).toBeDefined();
    expect(overlay.semanticOverlayIdentity).toMatch(/^[a-f0-9]{64}$/u);
    const unit = planOfficialApiSemanticWorkset("I moved to Berlin.", [
      { role: "user", content: "I moved to Berlin." }
    ]).units[0];
    if (unit === undefined) throw new Error("expected minted workset unit");
    expect(inspectSemanticArtifact(
      overlayRoot, unit.semanticKey, "official_api_signals:v1"
    ).status).toBe("provider_backed");
    expect(inspectSemanticArtifact(
      divertedRoot, unit.semanticKey, "official_api_signals:v1"
    ).status).toBe("missing");
  });

  it("fails closed when the sealed replay cannot fulfill the overlay", async () => {
    await writeFixtureDataset([
      buildQuestion("q001", "I moved to Berlin.", "I prefer TypeScript.")
    ]);
    await runExtractionFill({
      variant: VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      extractorFactory: (): BenchSignalExtractor => ({
        extract: async (input) => providerBackedExtractionResult(
          buildGroundedSignalResponse(input.userPrompt)
        )
      }),
      log: () => undefined
    });
    const overlayRoot = join(cacheRoot, "..", "semantic-overlay-stale");
    await expect(runExtractionFill({
      variant: VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      ingestionMode: "lazy_field",
      semanticArtifactRoot: overlayRoot,
      semanticTransport: createOfflineSemanticReplay({
        defaultResult: { kind: "failure", reason: "sealed replay unavailable" }
      }),
      log: () => undefined
    })).rejects.toThrow(/semantic fill failed closed/u);
  });

  it("does not succeed a lazy_field retry that still carries quarantined demand", async () => {
    const first = buildQuestion("q001", "I moved to Berlin.", "I prefer TypeScript.");
    const second = buildQuestion("q002", "I moved to Paris.", "I prefer Rust.");
    await writeFixtureDataset([first, second]);
    await runExtractionFill({
      variant: VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      extractorFactory: (): BenchSignalExtractor => ({
        extract: async (input) => providerBackedExtractionResult(
          buildGroundedSignalResponse(input.userPrompt)
        )
      }),
      log: () => undefined
    });
    const overlayRoot = join(cacheRoot, "..", "semantic-overlay-quarantine-retry");
    const mixed = await sealedReplayForLazyWindow({}, ["I moved to Paris."]);
    await expect(runExtractionFill({
      variant: VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      ingestionMode: "lazy_field",
      semanticArtifactRoot: overlayRoot,
      semanticTransport: mixed,
      log: () => undefined
    })).rejects.toThrow(/semantic fill failed closed/u);
    const berlin = planOfficialApiSemanticWorkset("I moved to Berlin.", [
      { role: "user", content: "I moved to Berlin." }
    ]).units[0];
    const paris = planOfficialApiSemanticWorkset("I moved to Paris.", [
      { role: "user", content: "I moved to Paris." }
    ]).units[0];
    if (berlin === undefined || paris === undefined) {
      throw new Error("expected minted workset units");
    }
    expect(inspectSemanticArtifact(
      overlayRoot, berlin.semanticKey, "official_api_signals:v1"
    ).status).toBe("provider_backed");
    expect(inspectSemanticArtifact(
      overlayRoot, paris.semanticKey, "official_api_signals:v1"
    ).status).toBe("quarantined");
    await expect(runExtractionFill({
      variant: VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      ingestionMode: "lazy_field",
      semanticArtifactRoot: overlayRoot,
      semanticTransport: await sealedReplayForLazyWindow({}),
      log: () => undefined
    })).rejects.toThrow(/unavailable=/u);
    expect(inspectSemanticArtifact(
      overlayRoot, paris.semanticKey, "official_api_signals:v1"
    ).status).toBe("quarantined");
  });
});
