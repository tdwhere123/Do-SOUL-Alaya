import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SeedExtractionPath } from "@do-soul/alaya-eval";
import type { LongMemEvalSnapshotManifest } from
  "../../../runs/snapshot/materialize.js";
import { makeShardProvenance } from "../runner/runner-concurrency-fixture.js";
import {
  currentCanonicalQuestions as questions,
  currentSnapshotExtractionAuthority as authorityFor,
  currentSnapshotManifestFor as manifestFor,
  currentSnapshotSidecarFor as sidecarFor
} from "./current-snapshot-fixture.js";

const roots: string[] = [];

vi.mock("../../../datasets/longmemeval/ingestion/fetch.js", () => ({
  loadDatasetWithIdentity: vi.fn(async () => ({
    questions,
    sha256: makeShardProvenance(0, 1).dataset_sha256!,
    checksumSource: "fixture",
    sourcePath: "fixture",
    promotionAuthority: {}
  }))
}));
vi.mock("../../../runs/snapshot/integrity.js", async (loadOriginal) => ({
  ...await loadOriginal<typeof import("../../../runs/snapshot/integrity.js")>(),
  verifySnapshotArtifactIntegrity: vi.fn(async () => undefined)
}));
vi.mock("../../../runs/snapshot/substrate-binding.js", () => ({
  assertSnapshotDatasetSubstrateIdentity: vi.fn()
}));
vi.mock("../../../runs/snapshot/seed-ledger/seed-ledger-binding.js", () => ({
  assertSnapshotSeedLedgerBinding: vi.fn()
}));

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("diagnostic snapshot consume authority", () => {
  it("accepts diagnostic_attributed cache-only complete fill without a gate contract", async () => {
    const previous = process.env.ALAYA_BENCH_GATE_CONTRACT_PATH;
    delete process.env.ALAYA_BENCH_GATE_CONTRACT_PATH;
    try {
      const { verifyCurrentRecallSnapshotAuthority } = await loadAuthority();
      await expect(verifyCurrentRecallSnapshotAuthority({
        ...await consumeInput(diagnosticManifest()),
        snapshotConsumeAuthority: "diagnostic"
      })).resolves.toMatchObject({
        datasetSha256: makeShardProvenance(0, 1).dataset_sha256
      });
    } finally {
      restoreEnv("ALAYA_BENCH_GATE_CONTRACT_PATH", previous);
    }
  });

  it("accepts an already-written attributed gate-ineligible diagnostic snapshot", async () => {
    const { verifyCurrentRecallSnapshotAuthority } = await loadAuthority();
    await expect(verifyCurrentRecallSnapshotAuthority({
      ...await consumeInput({
        ...withoutPromotionGate(manifestFor("q-1")),
        attribution: { status: "attributed", gate_eligible: false }
      }),
      snapshotConsumeAuthority: "diagnostic"
    })).resolves.toMatchObject({
      datasetSha256: makeShardProvenance(0, 1).dataset_sha256
    });
  });

  it("rejects live llm_calls and incomplete fill with the failed diagnostic check", async () => {
    const { verifyCurrentRecallSnapshotAuthority } = await loadAuthority();
    const accepted = await consumeInput(diagnosticManifest());

    await expect(verifyCurrentRecallSnapshotAuthority({
      ...accepted,
      snapshotConsumeAuthority: "diagnostic",
      manifest: {
        ...accepted.manifest,
        seed_extraction_path: liveSeedPath(accepted.manifest.seed_extraction_path!)
      }
    })).rejects.toThrow(/cache-only seed extraction path/u);

    await expect(verifyCurrentRecallSnapshotAuthority({
      ...accepted,
      snapshotConsumeAuthority: "diagnostic",
      manifest: incompleteFillManifest(accepted.manifest)
    })).rejects.toThrow(/complete v3 fill summary/u);
  });

  it("keeps promotion recall-eval rejected without a gate-eligible claim", async () => {
    const { verifyCurrentRecallSnapshotAuthority } = await loadAuthority();
    await expect(verifyCurrentRecallSnapshotAuthority(
      await consumeInput(diagnosticManifest())
    )).rejects.toThrow(/stored gate_eligible claim is false/u);

    await expect(verifyCurrentRecallSnapshotAuthority(
      await consumeInput({
        ...withoutPromotionGate(manifestFor("q-1")),
        attribution: { status: "attributed", gate_eligible: false }
      })
    )).rejects.toThrow(/stored gate_eligible claim is false/u);
  });
});

async function loadAuthority() {
  return import("../../../runs/snapshot/current/current-substrate-authority.js");
}

async function consumeInput(manifest: LongMemEvalSnapshotManifest) {
  const root = await mkdtemp(join(tmpdir(), "diagnostic-consume-"));
  roots.push(root);
  const snapshotDbPath = join(root, "snapshot.db");
  await writeFile(`${snapshotDbPath}.manifest.json`, JSON.stringify(manifest), "utf8");
  return {
    snapshotDbPath,
    variant: "longmemeval_s" as const,
    manifest,
    sidecar: sidecarFor("q-1"),
    extractionAuthority: authorityFor()
  };
}

function diagnosticManifest(): LongMemEvalSnapshotManifest {
  return {
    ...withoutPromotionGate(manifestFor("q-1")),
    attribution: { status: "diagnostic_attributed", gate_eligible: false }
  };
}

function withoutPromotionGate(
  manifest: LongMemEvalSnapshotManifest
): LongMemEvalSnapshotManifest {
  const provenance = manifest.run_provenance!;
  return {
    ...manifest,
    run_provenance: {
      ...provenance,
      code: {
        commit_sha7: provenance.code.commit_sha7,
        gate_sha256: null,
        worktree_state_sha256: null,
        executed_dist: provenance.code.executed_dist
      }
    }
  };
}

function incompleteFillManifest(
  manifest: LongMemEvalSnapshotManifest
): LongMemEvalSnapshotManifest {
  const extraction = manifest.extraction_provenance;
  if (extraction?.schema_version !== 3) {
    throw new Error("fixture requires v3 extraction");
  }
  return {
    ...manifest,
    extraction_provenance: { ...extraction, fill_status: "in_progress" }
  };
}

function liveSeedPath(path: SeedExtractionPath): SeedExtractionPath {
  return { ...path, llm_calls: 1 };
}

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}
