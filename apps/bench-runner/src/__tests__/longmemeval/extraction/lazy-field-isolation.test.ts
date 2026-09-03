import { mkdtemp, rm } from "node:fs/promises";
import { symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runExtractionFill, freezeExtractionFillOptions } from "../../../runs/extraction/extraction-fill.js";

describe("lazy_field fill isolation", () => {
  it("rejects mixing v3 fill authority", async () => {
    await expect(runExtractionFill({
      variant: "longmemeval_s",
      ingestionMode: "lazy_field",
      semanticArtifactRoot: "/tmp/semantic-overlay",
      authorityReceiptPath: "/tmp/receipt.json"
    })).rejects.toThrow(/cannot mix v3 fill authority/u);
  });

  it("rejects overlay without a semantic artifact root", async () => {
    await expect(runExtractionFill({
      variant: "longmemeval_s",
      ingestionMode: "lazy_field"
    })).rejects.toThrow(/semantic artifact root/u);
  });

  it("rejects equal, nested, and symlink-aliased historical roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "lazy-root-isolation-"));
    const alias = `${root}-alias`;
    symlinkSync(root, alias);
    try {
      for (const semanticArtifactRoot of [root, join(root, "nested"), alias]) {
        await expect(runExtractionFill({
          variant: "longmemeval_s", cacheRoot: root,
          ingestionMode: "lazy_field", semanticArtifactRoot
        })).rejects.toThrow(/must be disjoint/u);
      }
    } finally {
      await rm(alias, { force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a semantic overlay on the v3 fill path", async () => {
    await expect(runExtractionFill({
      variant: "longmemeval_s",
      semanticArtifactRoot: "/tmp/semantic-overlay"
    })).rejects.toThrow(/semantic overlay requires lazy_field/u);
  });

  it("freezes lazy roots so a later caller mutation cannot switch them", () => {
    const options = {
      variant: "longmemeval_s" as const,
      cacheRoot: "/tmp/lazy-isolation-historical",
      ingestionMode: "lazy_field" as const,
      semanticArtifactRoot: "/tmp/lazy-isolation-overlay",
      semanticMaxCalls: 3,
      semanticMaxFailures: 1
    };
    const frozen = freezeExtractionFillOptions(options);
    (options as { semanticArtifactRoot: string }).semanticArtifactRoot = options.cacheRoot;
    (options as { ingestionMode?: string }).ingestionMode = "precomputed_full";
    (options as { semanticMaxCalls: number }).semanticMaxCalls = 99;
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(frozen.semanticArtifactRoot).toBe("/tmp/lazy-isolation-overlay");
    expect(frozen.ingestionMode).toBe("lazy_field");
    expect(frozen.semanticMaxCalls).toBe(3);
  });
});
