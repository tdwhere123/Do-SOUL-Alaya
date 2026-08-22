const DIMENSIONS = 384;

process.title = "alaya-local-onnx-embed-stub";

if (typeof process.send !== "function") {
  throw new Error("local ONNX embedding stub child requires IPC");
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
  if (op === "warmup") {
    process.send({ id, ok: true });
    return;
  }
  if (op !== "embed") {
    process.send({
      id,
      ok: false,
      error: { name: "Error", message: "invalid local ONNX stub request" }
    });
    return;
  }
  const texts = Array.isArray(message.texts) ? message.texts : [];
  const probe = texts[0];
  if (probe === "__crash__") {
    process.exit(7);
    return;
  }
  if (probe === "__hang__") {
    return;
  }
  if (probe === "__empty__") {
    process.send({ id, ok: true, vectors: [] });
    return;
  }
  if (probe === "__empty_row__") {
    process.send({ id, ok: true, vectors: [[]] });
    return;
  }
  process.send({
    id,
    ok: true,
    vectors: texts.map((_, index) => stubRow(index))
  });
}

function stubRow(seed) {
  return Array.from({ length: DIMENSIONS }, (_unused, index) =>
    Math.sin(seed + index + 1) * 0.01
  );
}
