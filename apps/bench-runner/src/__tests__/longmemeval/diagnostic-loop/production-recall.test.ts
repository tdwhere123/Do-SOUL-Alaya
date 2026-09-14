import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildEmbeddingCacheOverlayReceipt
} from "../../../runs/snapshot/recall-eval/embedding-cache-overlay/contract.js";
import { defaultSnapshotOverlayReceiptPath } from
  "../../../runs/snapshot/recall-eval/embedding-cache-overlay/ensure.js";
import {
  buildProductionRecallEvalOptions,
  runProductionRecallPhase
} from "../../../runs/diagnostic-loop/production-recall.js";
import { resolveSnapshotIdentity } from
  "../../../runs/diagnostic-loop/authority/identity.js";
import { writeDiagnosticSnapshotFixture } from "./fixture.js";

const overlayRoots: string[] = [];

afterEach(async () => {
  await Promise.all(overlayRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("diagnostic-loop production recall options", () => {
  it("threads diagnostic consume authority and disabled embeddings for control", async () => {
    const prepared = {
      snapshot: "/tmp/checkpoint-snapshot.db",
      historyRoot: "/tmp/history",
      substrate: { cache_identity: "cache", snapshot_identity: "snap" },
      phase: "control_recall" as const,
      questionIds: ["q-1"]
    };
    const options = await buildProductionRecallEvalOptions(
      {
        request: {
          variant: "longmemeval_s",
          snapshotPath: "/tmp/request-snapshot.db",
          historyRoot: "/tmp/history"
        },
        checkpoints: new Map(),
        workRoot: "/tmp/work"
      } as never,
      "control",
      prepared
    );
    expect(options.snapshotConsumeAuthority).toBe("diagnostic");
    expect(options.snapshotDbPath).toBe("/tmp/checkpoint-snapshot.db");
    expect(options.embeddingMode).toBe("disabled");
    expect(options.embeddingCacheOverlayReceiptPath).toBeUndefined();
  });

  it("binds a planted snapshot sidecar overlay on treatment without a CLI flag", async () => {
    const planted = await plantOverlaySnapshot();
    const options = await buildProductionRecallEvalOptions(
      recallContext(planted.snapshotPath, {}),
      "treatment",
      {
        snapshot: planted.snapshotPath,
        historyRoot: "/tmp/history",
        substrate: { cache_identity: "cache", snapshot_identity: "snap" },
        phase: "treatment_recall",
        questionIds: ["q-1"]
      }
    );
    expect(options.embeddingCacheOverlayReceiptPath).toBe(planted.receiptPath);
    expect(options.embeddingMode).toBe("env");
  });

  it("lets --embedding-cache-overlay win over the snapshot sidecar", async () => {
    const planted = await plantOverlaySnapshot();
    const override = await plantReceiptBeside(
      planted.snapshotPath,
      "operator-overlay.json"
    );
    const options = await buildProductionRecallEvalOptions(
      recallContext(planted.snapshotPath, {
        embeddingCacheOverlayReceiptPath: override
      }),
      "treatment",
      {
        snapshot: planted.snapshotPath,
        historyRoot: "/tmp/history",
        substrate: { cache_identity: "cache", snapshot_identity: "snap" },
        phase: "treatment_recall",
        questionIds: ["q-1"]
      }
    );
    expect(options.embeddingCacheOverlayReceiptPath).toBe(override);
  });

  it("keeps a planted overlay out of control recall options", async () => {
    const planted = await plantOverlaySnapshot();
    const options = await buildProductionRecallEvalOptions(
      recallContext(planted.snapshotPath, {
        embeddingCacheOverlayReceiptPath: planted.receiptPath
      }),
      "control",
      {
        snapshot: planted.snapshotPath,
        historyRoot: "/tmp/history",
        substrate: { cache_identity: "cache", snapshot_identity: "snap" },
        phase: "control_recall",
        questionIds: ["q-1"]
      }
    );
    expect(options.embeddingCacheOverlayReceiptPath).toBeUndefined();
    expect(options.embeddingMode).toBe("disabled");
  });
});

describe("diagnostic-loop production recall phase gates", () => {
  it("revalidates the checkpoint-bound snapshot before recall", async () => {
    await expect(runProductionRecallPhase({
      request: {
        variant: "longmemeval_s",
        snapshotPath: "/tmp/request-snapshot.db",
        historyRoot: "/tmp/history"
      },
      checkpoints: new Map([
        ["extraction", { artifact_paths: {}, content_identity: "cache" }],
        ["snapshot", {
          artifact_paths: { snapshot: "/tmp/checkpoint-snapshot.db" },
          content_identity: "tampered-identity"
        }]
      ]),
      workRoot: "/tmp/work"
    } as never, "control")).rejects.toThrow(/checkpoint drifted|ENOENT|no such file/u);
  });

  it("fails closed when treatment has no overlay and cannot emit", async () => {
    const previous = process.env.ALAYA_RECALL_EVAL_EMBEDDING;
    process.env.ALAYA_RECALL_EVAL_EMBEDDING = "disabled";
    const root = await mkdtemp(join(tmpdir(), "production-recall-no-overlay-"));
    overlayRoots.push(root);
    const snapshotPath = await writeDiagnosticSnapshotFixture(root, "no-overlay");
    const identity = await resolveSnapshotIdentity(snapshotPath, "longmemeval_s");
    try {
      await expect(runProductionRecallPhase(
        {
          request: {
            variant: "longmemeval_s",
            snapshotPath,
            historyRoot: root,
            treatmentFactorCachePath: join(root, "factors.json")
          },
          checkpoints: new Map([
            ["extraction", { artifact_paths: {}, content_identity: "cache" }],
            ["snapshot", {
              artifact_paths: { snapshot: snapshotPath },
              content_identity: identity.identity_digest
            }]
          ]),
          workRoot: root
        } as never,
        "treatment"
      )).rejects.toThrow(/sealed embedding cache overlay/u);
    } finally {
      if (previous === undefined) delete process.env.ALAYA_RECALL_EVAL_EMBEDDING;
      else process.env.ALAYA_RECALL_EVAL_EMBEDDING = previous;
    }
  });

  it("rejects a planted receipt whose snapshot sha256 does not match", async () => {
    const planted = await plantOverlaySnapshot({ snapshotSha256: "d".repeat(64) });
    await expect(buildProductionRecallEvalOptions(
      recallContext(planted.snapshotPath, {}),
      "treatment",
      {
        snapshot: planted.snapshotPath,
        historyRoot: "/tmp/history",
        substrate: { cache_identity: "cache", snapshot_identity: "snap" },
        phase: "treatment_recall",
        questionIds: ["q-1"]
      }
    )).rejects.toThrow(/snapshot SHA-256 binding mismatch/u);
  });
});

describe("diagnostic-loop production recall live execution", () => {
  it("invokes the real recall-eval runner for control recall", async () => {
    const root = await mkdtemp(join(tmpdir(), "production-recall-live-"));
    overlayRoots.push(root);
    const snapshotPath = await writeDiagnosticSnapshotFixture(root, "live-control");
    const identity = await resolveSnapshotIdentity(snapshotPath, "longmemeval_s");
    const historyRoot = join(root, "history");
    await writeFile(join(root, "history-marker"), "history\n", "utf8");

    await expect(runProductionRecallPhase(
      {
        request: {
          variant: "longmemeval_s",
          snapshotPath,
          historyRoot
        },
        checkpoints: new Map([
          ["extraction", { artifact_paths: {}, content_identity: "cache" }],
          ["snapshot", {
            artifact_paths: { snapshot: snapshotPath },
            content_identity: identity.identity_digest
          }]
        ]),
        workRoot: root
      } as never,
      "control"
    )).rejects.toThrow();
  }, 120_000);
});

function recallContext(
  snapshotPath: string,
  request: {
    readonly embeddingCacheOverlayReceiptPath?: string;
  }
) {
  return {
    request: {
      variant: "longmemeval_s",
      snapshotPath,
      historyRoot: "/tmp/history",
      treatmentFactorCachePath: "/tmp/query-factors.json",
      ...request
    },
    checkpoints: new Map([
      ["extraction", { artifact_paths: {}, content_identity: "cache" }],
      ["snapshot", {
        artifact_paths: { snapshot: snapshotPath },
        content_identity: `identity:${snapshotPath}`
      }]
    ]),
    workRoot: "/tmp/work"
  } as never;
}

async function plantOverlaySnapshot(options?: {
  readonly snapshotSha256?: string;
}): Promise<{
  readonly snapshotPath: string;
  readonly receiptPath: string;
}> {
  const { snapshotManifestPath } = await import("../../../runs/snapshot/materialize.js");
  const root = await mkdtemp(join(tmpdir(), "production-recall-overlay-"));
  overlayRoots.push(root);
  const snapshotPath = join(root, "checkpoint-snapshot.db");
  const bytes = `snapshot-${overlayRoots.length}\n`;
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
  const receiptPath = defaultSnapshotOverlayReceiptPath(snapshotPath);
  await plantReceiptBeside(snapshotPath, basename(receiptPath), options?.snapshotSha256);
  return { snapshotPath, receiptPath };
}

async function plantReceiptBeside(
  snapshotPath: string,
  receiptName: string,
  snapshotSha256?: string
): Promise<string> {
  const { readFileSync } = await import("node:fs");
  const receiptPath = join(snapshotPath, "..", receiptName);
  const overlayPath = receiptPath.replace(/\.json$/u, ".sqlite");
  await writeFile(overlayPath, "overlay-sidecar\n", "utf8");
  const snapshotDigest = snapshotSha256 ??
    createHash("sha256").update(readFileSync(snapshotPath)).digest("hex");
  const receipt = buildEmbeddingCacheOverlayReceipt({
    source: {
      source_snapshot_db_sha256: snapshotDigest,
      source_snapshot_manifest_sha256: "b".repeat(64),
      source_schema_version: 1,
      recall_pipeline_version: "fusion-evidence-first-v3",
      vector_space: {
        provider_kind: "local_onnx",
        model_id: "fixture-model",
        schema_version: 1,
        dimensions: 2,
        d2q_input: "raw_content",
        model_artifact_sha256: "c".repeat(64)
      }
    },
    relativeOverlayPath: basename(overlayPath),
    overlaySha256: createHash("sha256").update("overlay-sidecar\n").digest("hex"),
    memoryEmbeddingCount: 1,
    evidenceEmbeddingCount: 0
  });
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return receiptPath;
}
