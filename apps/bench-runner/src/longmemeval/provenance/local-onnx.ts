import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

async function collectArtifactFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  entries.sort((left, right) =>
    Buffer.compare(Buffer.from(left.name, "utf8"), Buffer.from(right.name, "utf8"))
  );
  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error("local ONNX artifact tree must not contain symbolic links");
    }
    if (entry.isDirectory()) files.push(...await collectArtifactFiles(root, path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

export async function resolveLocalOnnxArtifactSha256(
  providerLabel: string,
  env: Readonly<Record<string, string | undefined>>
): Promise<string | undefined> {
  const prefix = "local_onnx:";
  const cacheRoot = env.ALAYA_LOCAL_EMBEDDING_CACHE_DIR?.trim();
  if (!providerLabel.startsWith(prefix) || !cacheRoot) return undefined;
  const suffix = providerLabel.slice(prefix.length);
  if (
    suffix.length === 0 ||
    isAbsolute(suffix) ||
    suffix.split(/[\\/]/u).some((segment) => segment === "" || segment === "." || segment === "..")
  ) throw new Error("local ONNX model id must stay within the cache root");
  const modelRoot = resolve(cacheRoot, suffix);
  let files: readonly string[];
  try {
    const [cacheReal, modelReal, modelMetadata] = await Promise.all([
      realpath(cacheRoot),
      realpath(modelRoot),
      lstat(modelRoot)
    ]);
    const fromCache = relative(cacheReal, modelReal);
    if (modelMetadata.isSymbolicLink() || fromCache.startsWith("..") || isAbsolute(fromCache)) {
      throw new Error("local ONNX artifact root escapes the cache root");
    }
    files = await collectArtifactFiles(modelRoot);
  } catch {
    throw new Error("local ONNX artifact tree is missing or unreadable");
  }
  if (files.length === 0) return undefined;
  const hash = createHash("sha256");
  hash.update("alaya-local-onnx-tree-v1\0", "utf8");
  for (const file of files) {
    const relativePath = Buffer.from(relative(modelRoot, file), "utf8");
    const metadata = await stat(file);
    updateFrame(hash, relativePath);
    updateUint64(hash, metadata.size);
    for await (const chunk of createReadStream(file)) hash.update(chunk);
  }
  return hash.digest("hex");
}

function updateFrame(hash: ReturnType<typeof createHash>, value: Buffer): void {
  updateUint64(hash, value.byteLength);
  hash.update(value);
}

function updateUint64(hash: ReturnType<typeof createHash>, value: number): void {
  const frame = Buffer.alloc(8);
  frame.writeBigUInt64BE(BigInt(value));
  hash.update(frame);
}
