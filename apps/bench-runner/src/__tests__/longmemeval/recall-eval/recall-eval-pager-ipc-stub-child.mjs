import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

process.title = "alaya-recall-eval-pager-stub";

if (typeof process.send !== "function") {
  throw new Error("recall-eval pager stub child requires IPC");
}

process.on("disconnect", () => process.exit(0));
process.on("message", (message) => {
  void handle(message);
});

let selectionBoundaryFixture;
let selectionRootLogPath;
let selectionQuestionIdOverride;
let selectionRootPath;
let recalledQuestionId;

async function handle(message) {
  const id = message?.id;
  if (typeof id !== "number" || typeof process.send !== "function") return;
  const op = message?.op;
  if (op === "close") {
    process.send({ id, ok: true, selectionArtifact: writeSelectionArtifact() });
    process.exit(0);
    return;
  }
  if (op === "open") {
    selectionBoundaryFixture = message?.open?.selectionBoundaryFixture;
    selectionRootLogPath = message?.open?.selectionRootLogPath;
    selectionQuestionIdOverride = message?.open?.selectionQuestionIdOverride;
    if (selectionBoundaryFixture !== undefined) {
      selectionRootPath = mkdtempSync(join(tmpdir(), "alaya-selection-replay-stub-"));
      if (typeof selectionRootLogPath === "string") {
        appendFileSync(selectionRootLogPath, `${selectionRootPath}\n`);
      }
    }
    process.send({
      id,
      ok: true,
      pid: process.pid,
      mapsHint: {
        pid: process.pid,
        comm: process.title,
        alaya_db_mappings: 0,
        onnxruntime_mappings: 0
      },
      selectionSpoolRootPath: selectionRootPath ?? null
    });
    return;
  }
  if (op !== "recall") {
    process.send({
      id,
      ok: false,
      error: { name: "Error", message: "invalid recall-eval pager stub request" }
    });
    return;
  }
  const probe = message?.recall?.questionId;
  if (probe === "__crash__") {
    process.exit(7);
    return;
  }
  if (probe === "__hang__") {
    return;
  }
  if (probe === "__empty__") {
    process.send({ id, ok: true });
    return;
  }
  recalledQuestionId = typeof probe === "string" ? probe : "q";
  process.send({
    id,
    ok: true,
    pack: stubPack(typeof probe === "string" ? probe : "q")
  });
}

function writeSelectionArtifact() {
  if (selectionBoundaryFixture === undefined || recalledQuestionId === undefined) return null;
  const rootPath = selectionRootPath;
  if (rootPath === undefined) throw new Error("selection root was not opened");
  const sourcePath = join(rootPath, "selection-boundaries.ndjson.gz");
  const record = JSON.stringify({
    question_id: typeof selectionQuestionIdOverride === "string"
      ? selectionQuestionIdOverride
      : recalledQuestionId,
    invocation_index: 0,
    authoritative: true,
    boundary: selectionBoundaryFixture
  }) + "\n";
  const artifact = gzipSync(Buffer.from(record, "utf8"));
  writeFileSync(sourcePath, artifact);
  return {
    rootPath,
    sourcePath,
    binding: {
      filename: "selection-boundaries.ndjson.gz",
      sha256: createHash("sha256").update(artifact).digest("hex"),
      bytes: artifact.byteLength,
      record_count: 1
    }
  };
}

function stubPack(questionId) {
  return {
    questionId,
    hitAt1: false,
    hitAt5: true,
    hitAt10: true,
    firstTier: "hot",
    latencyMs: 1,
    degradationReason: null,
    diagnostics: { candidates: [], delivered_results: [] },
    tokenMetrics: {},
    recallTokenEconomy: null,
    edgeProposalKpiRows: [],
    embeddingWarmup: null,
    queryEmbeddingWarmup: null,
    documentEmbeddingWarmupLatencyMs: null,
    deliveredObjectIds: ["obj-1"]
  };
}
