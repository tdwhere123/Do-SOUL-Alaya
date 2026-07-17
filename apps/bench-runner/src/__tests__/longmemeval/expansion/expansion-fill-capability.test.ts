import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  completion,
  datasetFixture,
  resetExpansionFillAuthorityFixture,
  state,
  targetManifest
} from "./expansion-fill-authority-fixture/fixture.js";
import {
  mintCapability,
  prepare,
  r3SpendApprovalFor
} from "./expansion-fill-authority-fixture/capability.js";
import { buildLongMemEvalExpansionLineage } from
  "../../../longmemeval/promotion/expansion/lineage/expansion-lineage.js";
import {
  prepareExpansionFillAuthority,
  revalidateExpansionFillAuthority
} from "../../../longmemeval/extraction/expansion-fill-authority.js";
import { runExtractionFill } from "../../../longmemeval/extraction/extraction-fill.js";
import { parseExpansionManifestArtifacts } from
  "../../../longmemeval/extraction/expansion-manifest-artifacts.js";

describe("500Q expansion fill authority", () => {
  beforeEach(resetExpansionFillAuthorityFixture);

  it("resumes an interrupted anchored fill only with a fresh live capability", async () => {
    const first = await prepare(mintCapability());
    state.identity = {
      manifestSha256: "b".repeat(64),
      manifest: targetManifest(first.sourceAnchor)
    };

    const resumed = await prepare(mintCapability());
    expect(resumed.sourceAnchor).toEqual(first.sourceAnchor);
    expect(resumed.nextTurns).toHaveLength(500);
  });

  it.each([101, 499, 501, 1_000])(
    "rejects a non-canonical paid fill window before delegate construction (%s)",
    async (limit) => {
      const extractorFactory = vi.fn();
      await expect(runExtractionFill({
        variant: "longmemeval_s",
        limit,
        cacheRoot: "/must-not-lock",
        extractorFactory
      })).rejects.toThrow(/canonical fill window/u);
      expect(extractorFactory).not.toHaveBeenCalled();
    }
  );

  it.each([
    { offset: 1, limit: 100 },
    { offset: 100, limit: 100 }
  ])("rejects canonical offset fill window $offset..$limit", async (window) => {
    const extractorFactory = vi.fn();
    await expect(runExtractionFill({
      variant: "longmemeval_s",
      ...window,
      cacheRoot: "/must-not-lock",
      extractorFactory
    })).rejects.toThrow(/canonical fill window/u);
    expect(extractorFactory).not.toHaveBeenCalled();
  });

  it("admits only the canonical 0..100 source window without capability", async () => {
    await expect(prepareExpansionFillAuthority({
      variant: "longmemeval_s",
      limit: 100
    }, "/cache")).resolves.toBeUndefined();
  });

  it("refuses canonical 0..500 before any fill preparation without a fresh R3 approval", async () => {
    const capability = await mintCapability();

    await expect(prepareExpansionFillAuthority({
      variant: "longmemeval_s",
      expansionCapability: capability
    }, "/cache")).rejects.toThrow(/fresh R3 spend approval/u);
  });

  it("binds R3 material evidence, identity, and the measured 500Q caps", async () => {
    const capability = await mintCapability();
    const approval = r3SpendApprovalFor(capability);

    await expect(prepareExpansionFillAuthority({
      variant: "longmemeval_s",
      expansionCapability: capability,
      r3SpendApproval: {
        ...approval,
        r2: { ...approval.r2, b_a_net_r5_wins: 4 }
      }
    }, "/cache")).rejects.toThrow(/net R@5 wins/u);

    await expect(prepareExpansionFillAuthority({
      variant: "longmemeval_s",
      expansionCapability: capability,
      r3SpendApproval: {
        ...approval,
        spend: { ...approval.spend, maximum_attempts: approval.spend.maximum_attempts + 1 }
      }
    }, "/cache")).rejects.toThrow(/110 percent attempt/u);

    await expect(prepareExpansionFillAuthority({
      variant: "longmemeval_s",
      expansionCapability: capability,
      r3SpendApproval: {
        ...approval,
        r2: { ...approval.r2, final_cache_identity_sha256: "b".repeat(64) },
        target: { ...approval.target, cache_identity_sha256: "b".repeat(64) }
      }
    }, "/cache")).rejects.toThrow(/cache identity/u);
  });

  it("preserves custom pinned datasets as experimental fill windows", async () => {
    state.dataset = { ...datasetFixture(), promotionAuthority: null };
    await expect(prepareExpansionFillAuthority({
      variant: "longmemeval_s",
      limit: 250,
      pinnedMetaRoot: "/custom-meta"
    }, "/cache")).resolves.toBeUndefined();
  });

  it("does not let custom pinned metadata bypass the canonical 500Q R3 gate", async () => {
    state.dataset = { ...datasetFixture(), promotionAuthority: null };
    await expect(prepareExpansionFillAuthority({
      variant: "longmemeval_s",
      limit: 500,
      pinnedMetaRoot: "/custom-meta"
    }, "/cache")).rejects.toThrow(/promotion-authorized dataset/u);
  });

  it("rejects extraction concurrency above the product ceiling before I/O", async () => {
    const extractorFactory = vi.fn();
    await expect(runExtractionFill({
      variant: "longmemeval_s",
      limit: 100,
      concurrency: 33,
      cacheRoot: "/must-not-lock",
      extractorFactory
    })).rejects.toThrow(/concurrency must be an integer from 1 to 32/u);
    expect(extractorFactory).not.toHaveBeenCalled();
  });

  it("rejects a normalized negative offset before delegate construction", async () => {
    const extractorFactory = vi.fn();
    await expect(runExtractionFill({
      variant: "longmemeval_s",
      offset: -1,
      cacheRoot: "/must-not-lock",
      extractorFactory
    })).rejects.toThrow(/negative offsets/u);
    expect(extractorFactory).not.toHaveBeenCalled();
  });

  it("rejects a tampered persisted source anchor on resume", async () => {
    const first = await prepare(mintCapability());
    const anchor = {
      ...first.sourceAnchor,
      source_cache: {
        ...first.sourceAnchor.source_cache,
        manifest_sha256: "0".repeat(64)
      }
    };
    state.identity = {
      manifestSha256: "b".repeat(64),
      manifest: targetManifest(anchor)
    };

    await expect(prepare(mintCapability())).rejects.toThrow(/source anchor differs/u);
  });

  it("rejects provider drift before any expansion delegate can be built", async () => {
    const capability = await mintCapability();
    state.config = {
      ...state.config,
      providerUrl: "https://different-provider.example/v1"
    };
    await expect(prepare(Promise.resolve(capability))).rejects.toThrow(
      /different provider identity/u
    );
  });

  it("detects mutation between pre-lock verification and locked revalidation", async () => {
    const prepared = await prepare(mintCapability());
    state.sourceCompletion = completion(100, 100, "7", "0");

    expect(() => revalidateExpansionFillAuthority(prepared)).toThrow(/content closure/u);
  });

  it("rejects a source anchor issued for a different live capability", async () => {
    const first = await prepare(mintCapability());
    state.identity = {
      manifestSha256: "b".repeat(64),
      manifest: targetManifest(first.sourceAnchor)
    };

    await expect(prepare(mintCapability("c".repeat(64)))).rejects.toThrow(
      /source anchor differs/u
    );
  });

  it("rejects target keyset and count drift before provider construction", async () => {
    const first = await prepare(mintCapability());
    state.identity = {
      manifestSha256: "b".repeat(64),
      manifest: { ...targetManifest(first.sourceAnchor), cached_turns: 99 }
    };
    await expect(prepare(mintCapability())).rejects.toThrow(/partial cache state/u);

    state.targetCompletion = completion(500, 100, "0", null);
    await expect(prepare(mintCapability())).rejects.toThrow(/source anchor differs/u);
  });

  it("rejects completed target lineage closure drift", async () => {
    const first = await prepare(mintCapability());
    const capability = await mintCapability();
    state.targetCompletion = completion(500, 500, "8", "6");
    const base = targetManifest(first.sourceAnchor, "complete");
    const lineage = buildLongMemEvalExpansionLineage(
      capability,
      state.targetCompletion,
      base
    );
    state.identity = {
      manifestSha256: "b".repeat(64),
      manifest: {
        ...base,
        expansion_lineage: {
          ...lineage,
          target_cache: {
            ...lineage.target_cache,
            content_closure_sha256: "0".repeat(64)
          }
        }
      }
    };

    await expect(prepare(mintCapability())).rejects.toThrow(/lineage|closure/u);
  });

  it("rejects statusless and complete-without-lineage expansion downgrades", async () => {
    const first = await prepare(mintCapability());
    expect(() => parseExpansionManifestArtifacts({
      record: { expansion_source_anchor: first.sourceAnchor },
      schemaVersion: 3,
      fill: {},
      filePath: "/cache/manifest.json"
    })).toThrow(/outside 500Q|invalid expansion state/u);
    expect(() => parseExpansionManifestArtifacts({
      record: { expansion_source_anchor: first.sourceAnchor },
      schemaVersion: 3,
      fill: { fill_status: "complete", window_offset: 0, window_limit: 500 },
      filePath: "/cache/manifest.json"
    })).toThrow(/invalid expansion state/u);
  });
});
