process.title = "alaya-recall-eval-pager-stub";

if (typeof process.send !== "function") {
  throw new Error("recall-eval pager stub child requires IPC");
}

process.on("disconnect", () => process.exit(0));
process.on("message", (message) => {
  void handle(message);
});

async function handle(message) {
  const id = message?.id;
  if (typeof id !== "number" || typeof process.send !== "function") return;
  const op = message?.op;
  if (op === "close") {
    process.send({ id, ok: true });
    process.exit(0);
    return;
  }
  if (op === "open") {
    await emitOpenProgress(id, message?.open);
    process.send({
      id,
      ok: true,
      pid: process.pid,
      mapsHint: {
        pid: process.pid,
        comm: process.title,
        alaya_db_mappings: 0,
        onnxruntime_mappings: 0
      }
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
  process.send({
    id,
    ok: true,
    pack: { ...stubPack(questionId), recallOptions: message.recall.recallOptions }
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
