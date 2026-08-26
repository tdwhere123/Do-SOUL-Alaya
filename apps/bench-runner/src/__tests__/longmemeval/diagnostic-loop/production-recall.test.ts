import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildEmbeddingCacheOverlayReceipt
} from "../../../bench/snapshot/recall-eval/embedding-cache-overlay/contract.js";
import { defaultSnapshotOverlayReceiptPath } from
  "../../../bench/snapshot/recall-eval/embedding-cache-overlay/ensure.js";
import { snapshotManifestPath } from "../../../bench/snapshot/materialize.js";

const { runRecallEval, resolveSnapshotIdentity, capturedOptions } = vi.hoisted(() => {
  const options: {
    current?: {
      readonly snapshotConsumeAuthority?: string;
      readonly snapshotDbPath?: string;
      readonly embeddingCacheOverlayReceiptPath?: string;
      readonly embeddingMode?: string;
    };
  } = {};
  return {
    capturedOptions: options,
    resolveSnapshotIdentity: vi.fn(async (path: string) => ({
      identity_digest: `identity:${path}`,
      question_ids: ["q-1"]
    })),
    runRecallEval: vi.fn(async (value: { readonly snapshotConsumeAuthority?: string }) => {
      options.current = value;
      return {
        completion: { status: "complete" },
        slug: "diagnostic-recall",
        kpiPath: "/tmp/kpi.json",
        reportPath: "/tmp/report.md",
        payload: {
          recall_eval_attribution: {
            evaluation_slice: {
              offset: 0,
              limit: null,
              evaluated_count: 1,
              question_id_digest:
                "8a3e90ba8a519e1e3e3da22b26bf3d8db2a56b4ae77f42e60b2eda9173930f92"
            }
          }
        }
      };
    })
  };
});

vi.mock("../../../bench/lifecycle/recall-eval/recall-eval-impl.js", () => ({
  runRecallEval
}));
vi.mock("../../../bench/diagnostic-loop/authority/identity.js", () => ({
  resolveSnapshotIdentity
}));
vi.mock("../../../bench/snapshot/integrity.js", () => ({
  sha256File: vi.fn(async (path: string) => {
    try {
      return createHash("sha256").update(readFileSync(path)).digest("hex");
    } catch {
      return `sha256:${path}`;
    }
  })
}));

const overlayRoots: string[] = [];

afterEach(async () => {
  await Promise.all(overlayRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("diagnostic-loop production recall consume authority", () => {
  it("threads diagnostic consume authority into recall-eval", async () => {
    const { runProductionRecallPhase } = await import(
      "../../../bench/diagnostic-loop/production-recall.js"
    );
    await runProductionRecallPhase({
      request: {
        variant: "longmemeval_s",
        snapshotPath: "/tmp/request-snapshot.db",
        historyRoot: "/tmp/history"
      },
      checkpoints: new Map([
        ["extraction", {
          artifact_paths: {},
          content_identity: "cache"
        }],
        ["snapshot", {
          artifact_paths: { snapshot: "/tmp/checkpoint-snapshot.db" },
          content_identity: "identity:/tmp/checkpoint-snapshot.db"
        }]
      ]),
      workRoot: "/tmp/work"
    } as never, "control");

    expect(capturedOptions.current?.snapshotConsumeAuthority).toBe("diagnostic");
    expect(capturedOptions.current?.snapshotDbPath).toBe("/tmp/checkpoint-snapshot.db");
    expect(capturedOptions.current?.embeddingMode).toBe("disabled");
  });

  it("revalidates the checkpoint-bound snapshot before recall", async () => {
    const { runProductionRecallPhase } = await import(
      "../../../bench/diagnostic-loop/production-recall.js"
    );
    runRecallEval.mockClear();

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
    } as never, "control")).rejects.toThrow(/checkpoint drifted/u);

    expect(runRecallEval).not.toHaveBeenCalled();
  });

  it("rejects a requested window larger than the checkpoint-bound snapshot", async () => {
    const { runProductionRecallPhase } = await import(
      "../../../bench/diagnostic-loop/production-recall.js"
    );
    runRecallEval.mockClear();

    await expect(runProductionRecallPhase({
      request: {
        variant: "longmemeval_s",
        snapshotPath: "/tmp/request-snapshot.db",
        historyRoot: "/tmp/history",
        limit: 2
      },
      checkpoints: new Map([
        ["extraction", { artifact_paths: {}, content_identity: "cache" }],
        ["snapshot", {
          artifact_paths: { snapshot: "/tmp/checkpoint-snapshot.db" },
          content_identity: "identity:/tmp/checkpoint-snapshot.db"
        }]
      ]),
      workRoot: "/tmp/work"
    } as never, "control")).rejects.toThrow(/not contained in the snapshot/u);

    expect(runRecallEval).not.toHaveBeenCalled();
  });

  it("binds a planted snapshot sidecar overlay on treatment without a CLI flag", async () => {
    const { runProductionRecallPhase } = await import(
      "../../../bench/diagnostic-loop/production-recall.js"
    );
    runRecallEval.mockClear();
    const planted = await plantOverlaySnapshot();

    await runProductionRecallPhase(
      recallContext(planted.snapshotPath, {}),
      "treatment"
    );

    expect(capturedOptions.current?.embeddingCacheOverlayReceiptPath)
      .toBe(planted.receiptPath);
    expect(capturedOptions.current?.embeddingMode).toBe("env");
  });

  it("lets --embedding-cache-overlay win over the snapshot sidecar", async () => {
    const { runProductionRecallPhase } = await import(
      "../../../bench/diagnostic-loop/production-recall.js"
    );
    runRecallEval.mockClear();
    const planted = await plantOverlaySnapshot();
    const override = await plantReceiptBeside(
      planted.snapshotPath,
      "operator-overlay.json"
    );

    await runProductionRecallPhase(
      recallContext(planted.snapshotPath, {
        embeddingCacheOverlayReceiptPath: override
      }),
      "treatment"
    );

    expect(capturedOptions.current?.embeddingCacheOverlayReceiptPath).toBe(override);
  });

  it("fails closed when treatment has no overlay and cannot emit", async () => {
    const { runProductionRecallPhase } = await import(
      "../../../bench/diagnostic-loop/production-recall.js"
    );
    runRecallEval.mockClear();
    const previous = process.env.ALAYA_RECALL_EVAL_EMBEDDING;
    process.env.ALAYA_RECALL_EVAL_EMBEDDING = "disabled";
    const snapshotPath = await writeRecallSnapshot();
    try {
      await expect(runProductionRecallPhase(
        recallContext(snapshotPath, {}),
        "treatment"
      )).rejects.toThrow(/sealed embedding cache overlay/u);
    } finally {
      if (previous === undefined) delete process.env.ALAYA_RECALL_EVAL_EMBEDDING;
      else process.env.ALAYA_RECALL_EVAL_EMBEDDING = previous;
    }
    expect(runRecallEval).not.toHaveBeenCalled();
  });

  it("rejects a planted receipt whose snapshot sha256 does not match", async () => {
    const { runProductionRecallPhase } = await import(
      "../../../bench/diagnostic-loop/production-recall.js"
    );
    runRecallEval.mockClear();
    const planted = await plantOverlaySnapshot({ snapshotSha256: "d".repeat(64) });

    await expect(runProductionRecallPhase(
      recallContext(planted.snapshotPath, {}),
      "treatment"
    )).rejects.toThrow(/snapshot SHA-256 binding mismatch/u);
    expect(runRecallEval).not.toHaveBeenCalled();
  });

  it("keeps a planted overlay out of control recall", async () => {
    const { runProductionRecallPhase } = await import(
      "../../../bench/diagnostic-loop/production-recall.js"
    );
    runRecallEval.mockClear();
    const planted = await plantOverlaySnapshot();

    await runProductionRecallPhase(
      recallContext(planted.snapshotPath, {
        embeddingCacheOverlayReceiptPath: planted.receiptPath
      }),
      "control"
    );

    expect(capturedOptions.current?.embeddingCacheOverlayReceiptPath).toBeUndefined();
    expect(capturedOptions.current?.embeddingMode).toBe("disabled");
  });
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
  const snapshotPath = await writeRecallSnapshot();
  const receiptPath = defaultSnapshotOverlayReceiptPath(snapshotPath);
  await plantReceiptBeside(
    snapshotPath,
    basename(receiptPath),
    options?.snapshotSha256
  );
  return { snapshotPath, receiptPath };
}

async function plantReceiptBeside(
  snapshotPath: string,
  receiptName: string,
  snapshotSha256?: string
): Promise<string> {
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

async function writeRecallSnapshot(): Promise<string> {
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
  return snapshotPath;
}
