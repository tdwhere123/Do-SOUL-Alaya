import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.on("message", (message) => {
  if (message?.op !== "warmup") return;
  const root = mkdtempSync(join(process.env.ALAYA_LOCAL_ONNX_SNAPSHOT_PARENT, "alaya-onnx-"));
  const sealed = join(root, "staging", "onnx");
  mkdirSync(sealed, { recursive: true });
  writeFileSync(join(sealed, "partially-copied-artifact"), "authored fixture bytes");
  chmodSync(sealed, 0o500);
  chmodSync(join(root, "staging"), 0o500);
  const outside = mkdtempSync(join(tmpdir(), "alaya-onnx-external-"));
  writeFileSync(join(outside, "canary"), "outside");
  symlinkSync(outside, join(root, "external-link"));
  // Emulate loading interrupted after sealing began. No provider is imported.
  process.on("SIGTERM", () => {});
  process.send({ fixtureRoot: root, fixtureOutside: outside });
});
