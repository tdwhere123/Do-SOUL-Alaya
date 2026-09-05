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
const selectionRecords = [];

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
    await emitOpenProgress(id, message?.open);
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
  const questionId = typeof probe === "string" ? probe : "q";
  if (selectionBoundaryFixture !== undefined) {
    selectionRecords.push({
      question_id: typeof selectionQuestionIdOverride === "string"
        ? selectionQuestionIdOverride
        : questionId,
      invocation_index: 0,
      authoritative: true,
      boundary: selectionBoundaryFixture
    });
  }
  process.send({
    id,
    ok: true,
    pack: stubPack(questionId)
  });
}

async function emitOpenProgress(id, open) {
  const everyMs = open?.progressEveryMs;
  const count = open?.progressCount;
  if (!Number.isInteger(everyMs) || everyMs < 1 ||
      !Number.isInteger(count) || count < 1) {
    return;
  }
  for (let completed = 1; completed <= count; completed += 1) {
    process.send({
      id,
      progress: true,
      sequence: open?.constantProgressSequence === true ? 1 : completed,
      stage: "stub_open",
      completed,
      total: count
    });
    if (completed < count) {
      await new Promise((resolve) => setTimeout(resolve, everyMs));
    }
  }
}

function writeSelectionArtifact() {
  if (selectionBoundaryFixture === undefined || selectionRecords.length === 0) return null;
  const rootPath = selectionRootPath;
  if (rootPath === undefined) throw new Error("selection root was not opened");
  const sourcePath = join(rootPath, "selection-boundaries.ndjson.gz");
  const record = `${selectionRecords.map((row) => JSON.stringify(row)).join("\n")}\n`;
  const artifact = gzipSync(Buffer.from(record, "utf8"));
  writeFileSync(sourcePath, artifact);
  return {
    rootPath,
    sourcePath,
    binding: {
      filename: "selection-boundaries.ndjson.gz",
      sha256: createHash("sha256").update(artifact).digest("hex"),
      bytes: artifact.byteLength,
      record_count: selectionRecords.length
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
