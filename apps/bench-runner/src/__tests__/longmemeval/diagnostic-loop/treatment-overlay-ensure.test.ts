import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildEmbeddingCacheOverlayReceipt
} from "../../../bench/snapshot/recall-eval/embedding-cache-overlay/contract.js";
import {
  defaultSnapshotOverlayReceiptPath,
  ensureTreatmentOverlayReceipt,
  maybeEmitSnapshotEmbeddingOverlay
} from "../../../bench/snapshot/recall-eval/embedding-cache-overlay/ensure.js";
import { snapshotManifestPath } from "../../../bench/snapshot/materialize.js";

const VECTOR_SPACE = Object.freeze({
  provider_kind: "local_onnx",
  model_id: "fixture-model",
  schema_version: 1,
  dimensions: 2,
  d2q_input: "raw_content" as const,
  model_artifact_sha256: "c".repeat(64)
});

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ensureTreatmentOverlayReceipt", () => {
  it("reuses a receipt whose snapshot sha256 matches and does not emit", async () => {
    const planted = await plantSnapshotReceipt();
    const emit = vi.fn(async () => ({
      memory_embedding_count: 1,
      evidence_embedding_count: 0
    }));

    await expect(ensureTreatmentOverlayReceipt({
      snapshotDbPath: planted.snapshotPath,
      emit
    })).resolves.toBe(planted.receiptPath);
    await expect(ensureTreatmentOverlayReceipt({
      snapshotDbPath: planted.snapshotPath,
      emit
    })).resolves.toBe(planted.receiptPath);
    expect(emit).not.toHaveBeenCalled();
  });

  it("rejects a receipt whose snapshot sha256 does not match", async () => {
    const planted = await plantSnapshotReceipt({ snapshotSha256: "d".repeat(64) });
    const emit = vi.fn(async () => ({
      memory_embedding_count: 1,
      evidence_embedding_count: 0
    }));

    await expect(ensureTreatmentOverlayReceipt({
      snapshotDbPath: planted.snapshotPath,
      emit
    })).rejects.toThrow(/snapshot SHA-256 binding mismatch/u);
    expect(emit).not.toHaveBeenCalled();
  });

  it("emits once when no receipt exists", async () => {
    const snapshotPath = await writeSnapshot();
    const emit = vi.fn(async () => ({
      memory_embedding_count: 3,
      evidence_embedding_count: 1
    }));

    await expect(ensureTreatmentOverlayReceipt({
      snapshotDbPath: snapshotPath,
      emit
    })).resolves.toBe(defaultSnapshotOverlayReceiptPath(snapshotPath));
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(defaultSnapshotOverlayReceiptPath(snapshotPath));
  });

  it("fails closed when emit produces no vectors", async () => {
    const snapshotPath = await writeSnapshot();

    await expect(ensureTreatmentOverlayReceipt({
      snapshotDbPath: snapshotPath,
      emit: async () => ({
        memory_embedding_count: 0,
        evidence_embedding_count: 0
      })
    })).rejects.toThrow(/produced no vectors/u);
  });

  it("lets an explicit receipt path win over the snapshot sidecar", async () => {
    const planted = await plantSnapshotReceipt();
    const override = await plantReceiptForSnapshot(
      planted.snapshotPath,
      "operator-overlay.json"
    );
    const emit = vi.fn(async () => ({
      memory_embedding_count: 1,
      evidence_embedding_count: 0
    }));

    await expect(ensureTreatmentOverlayReceipt({
      snapshotDbPath: planted.snapshotPath,
      receiptPathOverride: override.receiptPath,
      emit
    })).resolves.toBe(override.receiptPath);
    expect(emit).not.toHaveBeenCalled();
  });

  it("rejects a matching sha256 receipt in the wrong vector space", async () => {
    const planted = await plantSnapshotReceipt();
    const emit = vi.fn(async () => ({
      memory_embedding_count: 1,
      evidence_embedding_count: 0
    }));

    await expect(ensureTreatmentOverlayReceipt({
      snapshotDbPath: planted.snapshotPath,
      expectedVectorSpace: { ...VECTOR_SPACE, model_id: "other-model" },
      emit
    })).rejects.toThrow(/vector space binding mismatch/u);
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("maybeEmitSnapshotEmbeddingOverlay", () => {
  it("skips emit when admission is closed and no receipt exists", async () => {
    const snapshotPath = await writeSnapshot();
    await expect(maybeEmitSnapshotEmbeddingOverlay({
      snapshotDbPath: snapshotPath,
      env: { ALAYA_RECALL_EVAL_EMBEDDING: "disabled" }
    })).resolves.toBeNull();
  });

  it("reuses a matching sidecar without calling emit", async () => {
    const planted = await plantSnapshotReceipt();
    const emit = vi.fn(async () => ({
      memory_embedding_count: 1,
      evidence_embedding_count: 0
    }));
    await expect(maybeEmitSnapshotEmbeddingOverlay({
      snapshotDbPath: planted.snapshotPath,
      emit
    })).resolves.toBe(planted.receiptPath);
    expect(emit).not.toHaveBeenCalled();
  });

  it("rejects a mismatched sidecar instead of re-encoding", async () => {
    const planted = await plantSnapshotReceipt({ snapshotSha256: "e".repeat(64) });
    await expect(maybeEmitSnapshotEmbeddingOverlay({
      snapshotDbPath: planted.snapshotPath,
      emit: async () => ({
        memory_embedding_count: 1,
        evidence_embedding_count: 0
      })
    })).rejects.toThrow(/snapshot SHA-256 binding mismatch/u);
  });

  it("inspects only the CLI override and ignores a stale default sidecar", async () => {
    const planted = await plantSnapshotReceipt({ snapshotSha256: "e".repeat(64) });
    const override = await plantReceiptForSnapshot(
      planted.snapshotPath,
      "operator-overlay.json"
    );
    const emit = vi.fn(async () => ({
      memory_embedding_count: 1,
      evidence_embedding_count: 0
    }));
    await expect(maybeEmitSnapshotEmbeddingOverlay({
      snapshotDbPath: planted.snapshotPath,
      receiptPathOverride: override.receiptPath,
      emit
    })).resolves.toBe(override.receiptPath);
    expect(emit).not.toHaveBeenCalled();
  });

  it("does not emit when a CLI override receipt is missing", async () => {
    const snapshotPath = await writeSnapshot();
    const emit = vi.fn(async () => ({
      memory_embedding_count: 1,
      evidence_embedding_count: 0
    }));
    await expect(maybeEmitSnapshotEmbeddingOverlay({
      snapshotDbPath: snapshotPath,
      receiptPathOverride: join(dirname(snapshotPath), "missing-overlay.json"),
      emit
    })).resolves.toBeNull();
    expect(emit).not.toHaveBeenCalled();
  });

  it("fails closed when a receipt exists without snapshot artifact integrity", async () => {
    const planted = await plantSnapshotReceipt();
    await rm(snapshotManifestPath(planted.snapshotPath), { force: true });
    await expect(ensureTreatmentOverlayReceipt({
      snapshotDbPath: planted.snapshotPath,
      emit: async () => ({
        memory_embedding_count: 1,
        evidence_embedding_count: 0
      })
    })).rejects.toThrow(/snapshot artifact integrity/u);
  });
});

async function plantSnapshotReceipt(options?: {
  readonly snapshotSha256?: string;
}): Promise<{
  readonly snapshotPath: string;
  readonly receiptPath: string;
}> {
  const snapshotPath = await writeSnapshot();
  return {
    snapshotPath,
    ...(await plantReceiptForSnapshot(
      snapshotPath,
      basename(defaultSnapshotOverlayReceiptPath(snapshotPath)),
      options?.snapshotSha256
    ))
  };
}

async function plantReceiptForSnapshot(
  snapshotPath: string,
  receiptName: string,
  snapshotSha256?: string
): Promise<{ readonly receiptPath: string }> {
  const receiptPath = join(dirname(snapshotPath), receiptName);
  const overlayPath = receiptPath.replace(/\.json$/u, ".sqlite");
  await writeFile(overlayPath, "overlay-sidecar\n", "utf8");
  const receipt = buildEmbeddingCacheOverlayReceipt({
    source: {
      source_snapshot_db_sha256: snapshotSha256 ?? snapshotManifestDigest(snapshotPath),
      source_snapshot_manifest_sha256: "b".repeat(64),
      source_schema_version: 1,
      recall_pipeline_version: "fusion-evidence-first-v3",
      vector_space: VECTOR_SPACE
    },
    relativeOverlayPath: basename(overlayPath),
    overlaySha256: createHash("sha256").update("overlay-sidecar\n").digest("hex"),
    memoryEmbeddingCount: 1,
    evidenceEmbeddingCount: 0
  });
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return { receiptPath };
}

async function writeSnapshot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "treatment-overlay-"));
  roots.push(root);
  const snapshotPath = join(root, "snapshot.db");
  const bytes = `snapshot-${roots.length}\n`;
  await writeFile(snapshotPath, bytes, "utf8");
  await writeFile(
    snapshotManifestPath(snapshotPath),
    `${JSON.stringify({
      artifact_integrity: {
        db_sha256: createHash("sha256").update(bytes).digest("hex")
      }
    })}\n`,
    "utf8"
  );
  return snapshotPath;
}

function snapshotManifestDigest(snapshotPath: string): string {
  const manifest = JSON.parse(
    readFileSync(snapshotManifestPath(snapshotPath), "utf8")
  ) as { readonly artifact_integrity?: { readonly db_sha256?: string } };
  const digest = manifest.artifact_integrity?.db_sha256;
  if (digest === undefined) {
    throw new Error("planted snapshot manifest is missing db_sha256");
  }
  return digest;
}
