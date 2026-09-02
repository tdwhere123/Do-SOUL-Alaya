import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  embeddingOverlayBindPath,
  EMBEDDING_OVERLAY_BIND_FILENAME
} from "@do-soul/alaya-storage";
import { copyRegularFileNoFollow } from "../../bound-file.js";
import { readEmbeddingCacheOverlayReceipt } from "../embedding-cache-overlay/contract.js";

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
  const destOverlays: string[] = [];
  for (const sliceDbPath of input.sliceDbPaths) {
    destOverlays.push(replicateOneSlice(
      bindPath,
      overlaySource,
      document.overlay_filename,
      dirname(sliceDbPath)
    ));
  }
  assertDistinctOverlayInodes([overlaySource, ...destOverlays]);
}

export function isolateEmbeddingCacheOverlayReceipt(input: {
  readonly receiptPath: string;
  readonly destDir: string;
}): {
  readonly receiptPath: string;
  readonly overlayPath: string;
} {
  const receipt = readEmbeddingCacheOverlayReceipt(input.receiptPath);
  if (isAbsolute(receipt.overlay.path)) {
    throw new Error("embedding cache overlay path must be relative");
  }
  const sourceRoot = resolve(dirname(input.receiptPath));
  const sourceOverlay = resolve(sourceRoot, receipt.overlay.path);
  const destDir = resolve(input.destDir);
  const destReceiptPath = join(destDir, basename(input.receiptPath));
  const destOverlayPath = resolve(destDir, receipt.overlay.path);
  assertWithin(destDir, destOverlayPath);
  if (resolve(input.receiptPath) === destReceiptPath || sourceOverlay === destOverlayPath) {
    throw new Error("embedding overlay shard copy must not reuse the source bind path");
  }
  mkdirSync(dirname(destOverlayPath), { recursive: true });
  copyRegularFileNoFollow({
    sourcePath: sourceOverlay,
    targetPath: destOverlayPath,
    expectedSha256: receipt.overlay.sha256
  });
  writeFileSync(destReceiptPath, readFileSync(input.receiptPath));
  assertIsolatedOverlayFile(sourceOverlay, destOverlayPath);
  return { receiptPath: destReceiptPath, overlayPath: destOverlayPath };
}

export function assertIsolatedOverlayFile(sourcePath: string, destPath: string): void {
  const dest = lstatSync(destPath);
  if (!dest.isFile()) {
    throw new Error("embedding overlay working copy must be an isolated regular file");
  }
  const source = lstatSync(sourcePath);
  if (source.dev === dest.dev && source.ino === dest.ino) {
    throw new Error("embedding overlay working copy must not share an inode");
  }
}

export function assertDistinctOverlayInodes(overlayPaths: readonly string[]): void {
  const seen = new Set<string>();
  for (const overlayPath of overlayPaths) {
    const metadata = lstatSync(overlayPath);
    if (!metadata.isFile()) {
      throw new Error("embedding overlay working copy must be an isolated regular file");
    }
    const key = `${metadata.dev}:${metadata.ino}`;
    if (seen.has(key)) {
      throw new Error("embedding overlay shard copies must not share an inode");
    }
    seen.add(key);
  }
}

function replicateOneSlice(
  bindPath: string,
  overlaySource: string,
  overlayFilename: string,
  sliceDir: string
): string {
  const destBind = join(sliceDir, EMBEDDING_OVERLAY_BIND_FILENAME);
  const destOverlay = join(sliceDir, overlayFilename);
  copyFileSync(bindPath, destBind);
  placeIsolatedOverlayCopy(overlaySource, destOverlay);
  return destOverlay;
}

function placeIsolatedOverlayCopy(source: string, dest: string): void {
  if (existsSync(dest)) {
    try {
      assertIsolatedOverlayFile(source, dest);
      return;
    } catch {
      rmSync(dest, { force: true });
    }
  }
  copyFileSync(source, dest);
  assertIsolatedOverlayFile(source, dest);
}

function assertWithin(root: string, candidate: string): void {
  const fromRoot = relative(root, candidate);
  if (fromRoot !== "" && !fromRoot.startsWith("..") && !isAbsolute(fromRoot)) return;
  throw new Error("embedding cache overlay path must stay within the receipt directory");
}
