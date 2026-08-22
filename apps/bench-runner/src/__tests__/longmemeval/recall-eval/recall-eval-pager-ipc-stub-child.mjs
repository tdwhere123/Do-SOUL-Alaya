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
    process.send({ id, ok: true, selectionArtifact: null });
    process.exit(0);
    return;
  }
  if (op === "open") {
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
  process.send({
    id,
    ok: true,
    pack: stubPack(typeof probe === "string" ? probe : "q")
  });
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
