import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resetExpansionFillAuthorityFixture,
  state
} from "./expansion-fill-authority-fixture/fixture.js";
import {
  completeExpansionFixture,
  recallBundle
} from "./expansion-fill-authority-fixture/recall-bundle.js";
import {
  mintCapability,
  prepare
} from "./expansion-fill-authority-fixture/capability.js";
import { longMemEvalExpansionCapabilityData } from
  "../../../longmemeval/promotion/expansion/expansion-capability.js";
import { assertExpansionRecallAuthority } from
  "../../../longmemeval/promotion/expansion/authority/expansion-recall-authority.js";

describe("500Q recall lineage authority", () => {
  beforeEach(resetExpansionFillAuthorityFixture);
  afterEach(async () => {
    await Promise.all(reuseRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    ));
  });

  it("accepts immutable lineage after validator-only reauthorization", async () => {
    const frozen = await completeExpansionFixture();
    const reauthorized = await mintCapability(undefined, "4e16327" + "4".repeat(33));
    const frozenData = longMemEvalExpansionCapabilityData(frozen.capability);
    const reauthorizedData = longMemEvalExpansionCapabilityData(reauthorized);
    const bundle = recallBundle(frozen);

    expect(reauthorizedData.matrixAuthorizationSha256).not.toBe(
      frozenData.matrixAuthorizationSha256
    );
    expect(stableCapability(reauthorizedData)).toEqual(stableCapability(frozenData));
    await expect(assertExpansionRecallAuthority({
      options: recallOptions(reauthorized),
      bundle,
      recallWeightOverrides: undefined,
      env: await frozenReuseEnvironment(bundle)
    })).resolves.toBeUndefined();
  });

  it("keeps completed fill lineage strict after validator reauthorization", async () => {
    const frozen = await completeExpansionFixture();
    const reauthorized = await mintCapability(undefined, "4e16327" + "4".repeat(33));
    state.identity = {
      manifestSha256: "b".repeat(64),
      manifest: frozen.manifest
    };

    await expect(prepare(Promise.resolve(reauthorized))).rejects.toThrow(
      /lineage differs/u
    );
  });

  it("rejects differing anchor and lineage authorization receipts", async () => {
    const fixture = await completeExpansionFixture();
    const bundle = recallBundle(fixture);
    const extraction = bundle.manifest.extraction_provenance!;
    const provenance = bundle.manifest.run_provenance!;
    const runCache = provenance.extraction_cache!;
    const driftedLineage = {
      ...extraction.expansion_lineage!,
      matrix_authorization_sha256: "0".repeat(64)
    };
    const driftedBundle = {
      ...bundle,
      manifest: {
        ...bundle.manifest,
        extraction_provenance: { ...extraction, expansion_lineage: driftedLineage },
        run_provenance: {
          ...provenance,
          extraction_cache: { ...runCache, expansion_lineage: driftedLineage }
        }
      }
    };

    await expect(assertExpansionRecallAuthority({
      options: recallOptions(fixture.capability),
      bundle: driftedBundle,
      recallWeightOverrides: undefined,
      env: await frozenReuseEnvironment(driftedBundle)
    })).rejects.toThrow(/lineage differs/u);
  });
});

function recallOptions(
  expansionCapability: Awaited<ReturnType<typeof mintCapability>>
) {
  return {
    snapshotDbPath: "/snapshot/target.db",
    variant: "longmemeval_s" as const,
    historyRoot: "/history",
    policyShape: "stress" as const,
    simulateReport: "none" as const,
    expansionCapability
  };
}

function stableCapability(
  data: ReturnType<typeof longMemEvalExpansionCapabilityData>
) {
  return {
    contract: data.contractSha256,
    code: data.code,
    matrix: data.matrix,
    product: data.productDefault,
    source: data.sourceSelection,
    target: data.nextSelection
  };
}

const reuseRoots: string[] = [];

async function frozenReuseEnvironment(
  bundle: ReturnType<typeof recallBundle>
): Promise<Record<string, string>> {
  const root = await mkdtemp(join(tmpdir(), "recall-lineage-authority-"));
  reuseRoots.push(root);
  const path = join(root, "consumer-gate.json");
  const raw = `${JSON.stringify({
    schema_version: 1,
    code: {
      commit_sha: "7".repeat(40),
      commit_sha7: "7".repeat(7),
      worktree_state_sha256: "8".repeat(64)
    },
    snapshot_reuse: {
      manifest_sha256: bundle.snapshotManifestSha256,
      producer: bundle.manifest.run_provenance!.code
    }
  })}\n`;
  await writeFile(path, raw, "utf8");
  return {
    ALAYA_RECALL_EVAL_EMBEDDING: "env",
    ALAYA_BENCH_GATE_CONTRACT_PATH: path,
    ALAYA_BENCH_GATE_SHA256: createHash("sha256").update(raw).digest("hex")
  };
}
