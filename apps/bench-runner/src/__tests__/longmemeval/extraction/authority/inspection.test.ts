import { describe, expect, it, vi } from "vitest";
import {
  computeExtractionAuthorityWorktreeRevision,
  inspectExtractionAuthority
} from "../../../../longmemeval/extraction/authority/inspection.js";
import {
  assertExtractionAuthorityReceipt,
  createExtractionAuthorityReceipt
} from "../../../../longmemeval/extraction/authority/receipt.js";
import {
  buildExtractionFillQuestion,
  EXTRACTION_FILL_VARIANT,
  registerExtractionFillHooks
} from "../../extraction-fill/fixture.js";

let cacheRoot: string;
let dataDir: string;
let pinnedMetaRoot: string;
const writeFixtureDataset = registerExtractionFillHooks((roots) => {
  ({ cacheRoot, dataDir, pinnedMetaRoot } = roots);
});

describe("no-network extraction authority inspection", () => {
  it("binds a receipt revision to tracked and untracked worktree content", () => {
    const input = {
      head: "a".repeat(40),
      trackedDiff: Buffer.from("diff --git a/a.ts b/a.ts\n", "utf8"),
      untrackedFiles: [{ path: "new.ts", mode: 0o644, blobDigest: "b".repeat(40) }]
    };
    const baseline = computeExtractionAuthorityWorktreeRevision(input);

    expect(computeExtractionAuthorityWorktreeRevision({
      ...input,
      trackedDiff: Buffer.from("diff --git a/a.ts b/a.ts\n+changed\n", "utf8")
    })).not.toBe(baseline);
    expect(computeExtractionAuthorityWorktreeRevision({
      ...input,
      untrackedFiles: [{ ...input.untrackedFiles[0]!, blobDigest: "c".repeat(40) }]
    })).not.toBe(baseline);
    expect(baseline).toMatch(/^git-worktree-v1:[a-f0-9]{40}:[a-f0-9]{64}$/u);
  });

  it("records exact identity and missing-key inventory without calling a provider", async () => {
    await writeFixtureDataset([
      buildExtractionFillQuestion("q001", "User: alpha", "User: decoy"),
      buildExtractionFillQuestion("q002", "User: beta", "User: distraction")
    ]);
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const inspected = await inspectExtractionAuthority({
      variant: EXTRACTION_FILL_VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      revision: "a".repeat(40),
      action: "fill"
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(inspected.observation).toMatchObject({
      revision: "a".repeat(40),
      extraction: { manifestSha256: null, rawContentClosureSha256: null },
      inventory: { expectedTurns: 4, validTurns: 0, missingTurns: 4, invalidTurns: 0, orphanTurns: 0 }
    });
    expect(inspected.missingKeys).toHaveLength(4);
    expect(inspected.writerLock).toBe("absent");
    expect(inspected.disk.status).toBe("available");
    expect(inspected.modelReadiness).toBe("not_probed");
  });

  it("permits only the inspected canonical operation and selection", async () => {
    await writeFixtureDataset([
      buildExtractionFillQuestion("q001", "User: alpha", "User: decoy"),
      buildExtractionFillQuestion("q002", "User: beta", "User: distraction")
    ]);
    const inspected = await inspectExtractionAuthority({
      variant: EXTRACTION_FILL_VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      revision: "a".repeat(40),
      action: "fill"
    });
    const receipt = createExtractionAuthorityReceipt({
      action: "fill",
      observation: inspected.observation,
      outputTokenCap: { field: "max_tokens", value: 512 },
      priceEstimate: {
        inputUsdPerMillion: 1,
        outputUsdPerMillion: 2,
        maximumInputTokensPerAttempt: 300
      },
      diskFloorBytes: 0,
      inspection: {
        writerLock: inspected.writerLock,
        disk: inspected.disk,
        credentialStatus: inspected.credentialStatus,
        modelReadiness: inspected.modelReadiness
      }
    });
    const changedSelection = await inspectExtractionAuthority({
      variant: EXTRACTION_FILL_VARIANT,
      limit: 1,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      revision: "a".repeat(40),
      action: "fill"
    });
    const changedAction = await inspectExtractionAuthority({
      variant: EXTRACTION_FILL_VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      revision: "a".repeat(40),
      action: "probe"
    });

    expect(() => assertExtractionAuthorityReceipt(receipt, inspected.observation)).not.toThrow();
    expect(() => assertExtractionAuthorityReceipt(receipt, changedSelection.observation))
      .toThrow(/identity drift|does not match/u);
    expect(() => assertExtractionAuthorityReceipt(receipt, changedAction.observation))
      .toThrow(/identity drift|does not match/u);
  });
});
