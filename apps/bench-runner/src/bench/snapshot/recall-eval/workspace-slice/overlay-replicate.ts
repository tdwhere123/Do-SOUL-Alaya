import { copyFileSync, existsSync, readFileSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  embeddingOverlayBindPath,
  EMBEDDING_OVERLAY_BIND_FILENAME
} from "@do-soul/alaya-storage";

export function replicateEmbeddingOverlayBind(input: {
  readonly packedDbPath: string;
  readonly sliceDbPaths: readonly string[];
}): void {
  const bindPath = embeddingOverlayBindPath(input.packedDbPath);
  if (!existsSync(bindPath)) return;
  const document = JSON.parse(readFileSync(bindPath, "utf8")) as {
    readonly overlay_filename?: unknown;
  };
  if (typeof document.overlay_filename !== "string") {
    throw new Error("embedding overlay bind document is invalid");
  }
  const overlaySource = join(dirname(input.packedDbPath), document.overlay_filename);
  if (!existsSync(overlaySource)) {
    throw new Error("embedding overlay file is missing");
  }
  for (const sliceDbPath of input.sliceDbPaths) {
    replicateOneSlice(bindPath, overlaySource, document.overlay_filename, dirname(sliceDbPath));
  }
}

function replicateOneSlice(
  bindPath: string,
  overlaySource: string,
  overlayFilename: string,
  sliceDir: string
): void {
  const destBind = join(sliceDir, EMBEDDING_OVERLAY_BIND_FILENAME);
  const destOverlay = join(sliceDir, overlayFilename);
  copyFileSync(bindPath, destBind);
  if (existsSync(destOverlay)) return;
  try {
    symlinkSync(overlaySource, destOverlay);
  } catch {
    copyFileSync(overlaySource, destOverlay);
  }
}
