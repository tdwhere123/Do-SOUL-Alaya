import { describe, expect, it, vi } from "vitest";
import type { SeedExtractionPath } from "@do-soul/alaya-eval";
import type { LongMemEvalRunProvenance } from "../../../bench/provenance/run.js";
import {
  currentCanonicalQuestions as questions,
  currentSnapshotExtractionAuthority as authorityFor,
  currentSnapshotManifestFor as manifestFor,
  currentSnapshotSidecarFor as sidecarFor
} from "./current-snapshot-fixture.js";

vi.mock("../../../bench/snapshot/substrate-binding.js", () => ({
  assertSnapshotDatasetSubstrateIdentity: vi.fn()
}));
vi.mock("../../../bench/snapshot/seed-ledger/seed-ledger-binding.js", () => ({
  assertSnapshotSeedLedgerBinding: vi.fn()
}));

describe("diagnostic snapshot write authority", () => {
  it("accepts cache-only complete fill without a promotion gate contract", async () => {
    const previous = process.env.ALAYA_BENCH_GATE_CONTRACT_PATH;
    delete process.env.ALAYA_BENCH_GATE_CONTRACT_PATH;
    try {
      const { assertCurrentSnapshotWriteAuthority } = await loadAuthority();
      const input = {
        ...await writeInput(),
        runProvenance: withoutPromotionGate(await boundProvenance()),
        snapshotWriteAuthority: "diagnostic" as const
      };
      expect(() => assertCurrentSnapshotWriteAuthority(input)).not.toThrow();
    } finally {
      restoreEnv("ALAYA_BENCH_GATE_CONTRACT_PATH", previous);
    }
  });

  it("rejects live llm_calls and incomplete fill with the failed check", async () => {
    const { assertCurrentSnapshotWriteAuthority } = await loadAuthority();
    const input = await writeInput();
    const diagnostic = {
      ...input,
      runProvenance: withoutPromotionGate(input.runProvenance),
      snapshotWriteAuthority: "diagnostic" as const
    };

    expect(() => assertCurrentSnapshotWriteAuthority({
      ...diagnostic,
      seedExtractionPath: liveSeedPath(input.seedExtractionPath)
    })).toThrow(/cache-only seed extraction path/u);

    expect(() => assertCurrentSnapshotWriteAuthority({
      ...diagnostic,
      extraction: { ...input.extraction, fill_status: "in_progress" },
      runProvenance: {
        ...diagnostic.runProvenance,
        extraction_cache: {
          ...diagnostic.runProvenance.extraction_cache!,
          fill_status: "in_progress"
        }
      }
    })).toThrow(/complete v3 fill summary/u);

    expect(() => assertCurrentSnapshotWriteAuthority({
      ...diagnostic,
      runProvenance: {
        ...diagnostic.runProvenance,
        execution: {
          ...diagnostic.runProvenance.execution,
          offset: 10,
          evaluated_count: 1
        }
      }
    })).toThrow(/not contained in the cache fill window/u);

    expect(() => assertCurrentSnapshotWriteAuthority({
      ...diagnostic,
      datasetSha256: "f".repeat(64)
    })).toThrow(/dataset identity mismatch/u);
  });

  it("keeps promotion writes rejected without a frozen gate contract", async () => {
    const { assertCurrentSnapshotWriteAuthority } = await loadAuthority();
    const input = {
      ...await writeInput(),
      runProvenance: withoutPromotionGate(await boundProvenance())
    };
    expect(() => assertCurrentSnapshotWriteAuthority(input))
      .toThrow(/gate-eligible cache-only provenance/u);
  });
});

async function loadAuthority() {
  return import("../../../bench/snapshot/current/current-substrate-authority.js");
}

async function boundProvenance(): Promise<LongMemEvalRunProvenance> {
  const manifest = manifestFor("q-1");
  const { bindSnapshotRunProvenanceAuthority } = await import(
    "../../../bench/snapshot/run-provenance.js"
  );
  return bindSnapshotRunProvenanceAuthority(manifest.run_provenance!, authorityFor());
}

async function writeInput() {
  const manifest = manifestFor("q-1");
  const extraction = manifest.extraction_provenance;
  if (extraction?.schema_version !== 3) throw new Error("fixture requires v3 extraction");
  return {
    dbPath: "/missing/diagnostic-write.db",
    sidecar: sidecarFor("q-1"),
    canonicalQuestions: questions,
    extraction,
    extractionAuthority: authorityFor(),
    seedExtractionPath: manifest.seed_extraction_path!,
    runProvenance: await boundProvenance(),
    datasetSha256: manifest.dataset_sha256!
  };
}

function withoutPromotionGate(
  provenance: LongMemEvalRunProvenance
): LongMemEvalRunProvenance {
  return {
    ...provenance,
    code: {
      commit_sha7: provenance.code.commit_sha7,
      gate_sha256: null,
      worktree_state_sha256: null,
      executed_dist: provenance.code.executed_dist
    }
  };
}

function liveSeedPath(path: SeedExtractionPath): SeedExtractionPath {
  return { ...path, llm_calls: 1 };
}

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}
