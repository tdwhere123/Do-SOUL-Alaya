import { existsSync } from "node:fs";
import { join } from "node:path";
import { writeExtractionCacheManifest } from
  "../../../runs/extraction/cache/extraction-cache-manifest.js";
import { describe, expect, it } from "vitest";
import { planOfficialApiSemanticWorkset } from "@do-soul/alaya-soul";
import { runExtractionFill } from "../../../runs/extraction/extraction-fill.js";
import { readExtractionCacheManifestIdentity } from
  "../../../runs/extraction/cache/extraction-cache-manifest.js";
import {
  inspectSemanticArtifact
} from "../../../runs/extraction/cache/semantic-artifact/store.js";
import { signalsEnvelope } from "../compile-seed/compile-seed-fixture.js";
import type { BenchSignalExtractor } from "../../../runs/compile-seed.js";
import {
  buildExtractionFillQuestion as buildQuestion,
  buildGroundedSignalResponse,
  EXTRACTION_FILL_VARIANT as VARIANT,
  providerBackedExtractionResult,
  registerExtractionFillHooks
} from "./fixture.js";
import type { SemanticFillTask } from "../../../runs/extraction/fill/semantic-fill-executor.js";

let cacheRoot: string;
let dataDir: string;
let pinnedMetaRoot: string;
const writeFixtureDataset = registerExtractionFillHooks((roots) => {
  ({ cacheRoot, dataDir, pinnedMetaRoot } = roots);
});

function overlayRawJson(members: readonly SemanticFillTask[]): string {
  return JSON.stringify({
    signals: members.map((member) => {
      const envelope = JSON.parse(signalsEnvelope([
        { distilled: member.text, matched: member.text }
      ])) as { signals: Record<string, unknown>[] };
      envelope.signals[0]!.source_locator = {
        contract_version: 2,
        kind: "assertion_catalog",
        assertion_id: member.assertionId
      };
      return envelope.signals[0];
    })
  });
}

describe("runExtractionFill lazy_field success", () => {
  it("admits overlay artifacts without pinning or finishing v3", async () => {
    await writeFixtureDataset([
      buildQuestion("q001", "I moved to Berlin.", "I prefer TypeScript.")
    ]);
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
      semanticTransport: {
        complete: (members) => {
          expect(existsSync(join(overlayRoot, ".extraction-fill.lock"))).toBe(true);
          expect(existsSync(join(cacheRoot, ".extraction-fill.lock"))).toBe(false);
          return { kind: "raw", rawJson: overlayRawJson(members) };
        }
      },
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

  it("fails closed if complete v3 identity changes during overlay", async () => {
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
      semanticTransport: {
        complete: (members) => {
          const identity = readExtractionCacheManifestIdentity(cacheRoot);
          if (identity === undefined) throw new Error("expected complete v3");
          writeExtractionCacheManifest(cacheRoot, {
            ...identity.manifest,
            built_at: "2099-01-01T00:00:00.000Z"
          });
          return { kind: "raw", rawJson: overlayRawJson(members) };
        }
      },
      log: () => undefined
    })).rejects.toThrow(/lost complete extraction authority/u);
  });
});
