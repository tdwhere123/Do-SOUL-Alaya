import { createHash } from "node:crypto";
import { CoreError } from "../shared/errors.js";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const MAX_ARTIFACT_FILES = 128;
const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;

async function artifactRoot(cacheRoot: string, modelId: string): Promise<string> {
  const suffix = modelId.trim();
  if (!suffix || isAbsolute(suffix) || suffix.split(/[\\/]/u).some(part => !part || part === "." || part === "..")) {
    throw new CoreError("VALIDATION", "local ONNX model id must stay within the cache root");
  }
  const cacheReal = await realpath(cacheRoot);
  const root = resolve(cacheReal, suffix);
  await assertUnlinkedPath(cacheReal, root);
  const modelReal = await realpath(root);
  if (modelReal !== root) throw new CoreError("VALIDATION", "local ONNX artifact root escapes the cache root");
  return root;
}

async function assertUnlinkedPath(root: string, file: string): Promise<void> {
  const suffix = relative(root, file);
  if (suffix.startsWith("..") || isAbsolute(suffix)) throw new CoreError("VALIDATION", "local ONNX artifact path escapes its root");
  let current = root;
  for (const part of suffix.split(sep).filter(Boolean)) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new CoreError("VALIDATION", "local ONNX artifact tree must not contain symbolic links");
  }
}

async function collectArtifactFiles(root: string, current = root, files: string[] = [], budget?: { entries: number }): Promise<string[]> {
  if (budget && relative(root, current).split(sep).length > 16) throw new CoreError("VALIDATION", "local ONNX artifact directory capacity exceeded");
  const entries = await readdir(current, { withFileTypes: true });
  if (budget && entries.length > MAX_ARTIFACT_FILES) throw new CoreError("VALIDATION", "local ONNX artifact directory capacity exceeded");
  entries.sort((left, right) => Buffer.compare(Buffer.from(left.name, "utf8"), Buffer.from(right.name, "utf8")));
  for (const entry of entries) {
    if (budget && ++budget.entries > 512) throw new CoreError("VALIDATION", "local ONNX artifact directory capacity exceeded");
    const file = join(current, entry.name);
    if (entry.isSymbolicLink()) throw new CoreError("VALIDATION", "local ONNX artifact tree must not contain symbolic links");
    if (entry.isDirectory()) await collectArtifactFiles(root, file, files, budget);
    else if (entry.isFile()) files.push(file);
    else throw new CoreError("VALIDATION", "local ONNX artifact tree contains a non-file artifact");
    if (budget && files.length > MAX_ARTIFACT_FILES) throw new CoreError("VALIDATION", "local ONNX artifact file capacity exceeded");
  }
  return files;
}

async function readArtifact(root: string, file: string, consume: (chunk: Buffer) => Promise<void> | void): Promise<number> {
  await assertUnlinkedPath(root, file);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new CoreError("VALIDATION", "local ONNX artifact type unsupported");
    const linked = await lstat(file);
    if (linked.dev !== before.dev || linked.ino !== before.ino) throw new CoreError("CONFLICT", "local ONNX artifact changed while opening", { subCode: "CONCURRENT_MODIFICATION" });
    await assertUnlinkedPath(root, file);
    let count = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      count += chunk.length;
      if (count > before.size) throw new CoreError("CONFLICT", "local ONNX artifact changed while reading", { subCode: "CONCURRENT_MODIFICATION" });
      await consume(chunk);
    }
    const after = await handle.stat();
    if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new CoreError("CONFLICT", "local ONNX artifact changed while reading", { subCode: "CONCURRENT_MODIFICATION" });
    }
    return count;
  } finally { await handle.close(); }
}

/** Historical bench framing is unchanged: sorted UTF-8 path frame, uint64 size, raw bytes. */
export async function resolveLocalArtifactTreeSha256(cacheRoot: string, modelId: string): Promise<string> {
  let root: string;
  let files: readonly string[];
  try {
    root = await artifactRoot(cacheRoot, modelId);
    files = await collectArtifactFiles(root);
  } catch (error) {
    if (error instanceof Error && error.message.includes("model id must stay")) throw error;
    throw new CoreError("CONFLICT", "local ONNX artifact tree is missing or unreadable", { subCode: "PORT_UNAVAILABLE", cause: error });
  }
  if (files.length === 0) throw new CoreError("NOT_FOUND", "local ONNX artifact tree is missing or unreadable");
  const hash = createHash("sha256").update("alaya-local-onnx-tree-v1\0", "utf8");
  for (const file of files) {
    const metadata = await lstat(file);
    const relativePath = Buffer.from(relative(root, file), "utf8");
    updateUint64(hash, relativePath.byteLength);
    hash.update(relativePath);
    updateUint64(hash, metadata.size);
    const count = await readArtifact(root, file, chunk => { hash.update(chunk); });
    if (count !== metadata.size) throw new CoreError("CONFLICT", "local ONNX artifact size changed before hashing", { subCode: "CONCURRENT_MODIFICATION" });
  }
  return hash.digest("hex");
}

export interface VerifiedLocalOnnxArtifacts {
  readonly modelRoot: string;
  readonly treeSha256: string;
  readonly weightSha256: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly tokenizerConfig: Readonly<Record<string, unknown>>;
  dispose(): Promise<void>;
}

/** Per-loaded-session private copy. Never hash a mutable cache then load it later. */
export async function snapshotLocalOnnxArtifacts(cacheRoot: string, modelId: string, snapshotParent = tmpdir()): Promise<VerifiedLocalOnnxArtifacts> {
  const root = await artifactRoot(cacheRoot, modelId);
  // The fork host owns this directory until the child has actually exited. An
  // interrupted copy/load cannot execute this module's normal finally cleanup.
  const privateRoot = await mkdtemp(join(snapshotParent, "alaya-onnx-"));
  const stage = join(privateRoot, "staging");
  try {
    await mkdir(stage, { mode: 0o700 });
    let bytes = 0;
    for (const source of await collectArtifactFiles(root, root, [], { entries: 0 })) {
      const target = join(stage, relative(root, source));
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const destination = await open(target, "wx", 0o600);
      try {
        await readArtifact(root, source, async chunk => {
          bytes += chunk.length;
          if (bytes > MAX_ARTIFACT_BYTES) throw new CoreError("VALIDATION", "local ONNX artifact byte capacity exceeded");
          await destination.writeFile(chunk);
        });
        await destination.sync();
      } finally { await destination.close(); }
    }
    // Required q8 encoder and tokenizer artifacts must all exist in the private copy.
    const weight = join(stage, "onnx/model_quantized.onnx");
    const weightHash = createHash("sha256");
    await readArtifact(stage, weight, chunk => { weightHash.update(chunk); });
    await assertSelfContainedOnnx(weight);
    const config = await readJson(stage, "config.json");
    const tokenizerConfig = await readJson(stage, "tokenizer_config.json");
    await lstat(join(stage, "tokenizer.json"));
    await lstat(join(stage, "special_tokens_map.json"));
    const treeSha256 = await resolveLocalArtifactTreeSha256(privateRoot, "staging");
    const published = join(privateRoot, treeSha256);
    await rename(stage, published); // Private parent and unique destination: no loaded tree is overwritten.
    await sealTree(published);
    return Object.freeze({ modelRoot: published, treeSha256, weightSha256: weightHash.digest("hex"), config, tokenizerConfig,
      dispose: (() => {
        let disposal: Promise<void> | undefined;
        return () => disposal ??= removePrivateTree(privateRoot);
      })() });
  } catch (error) { await removePrivateTree(privateRoot); throw error; }
}

async function readJson(root: string, name: string): Promise<Readonly<Record<string, unknown>>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  await readArtifact(root, join(root, name), chunk => {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) throw new CoreError("VALIDATION", "local ONNX configuration too large");
    chunks.push(chunk);
  });
  return Object.freeze(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
}

async function sealTree(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = join(root, entry.name);
    if (entry.isDirectory()) await sealTree(file);
    else await chmod(file, 0o400);
  }
  await chmod(root, 0o500);
}
// Both the snapshot disposer and the fork host use this owner after exit. Never
// chmod through a symlink: a partial copy may contain one beside sealed dirs.
export async function removePrivateTree(root: string): Promise<void> {
  async function unseal(directory: string): Promise<void> {
    if (!(await lstat(directory)).isDirectory()) {
      throw new CoreError("CONFLICT", "Local ONNX private tree root is not a directory", { subCode: "CONCURRENT_MODIFICATION" });
    }
    await chmod(directory, 0o700);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await unseal(join(directory, entry.name));
    }
  }
  await unseal(root);
  await rm(root, { recursive: true, force: true });
}
/** ONNX protobuf containment fields. Inspect metadata, skipping raw tensor bytes without allocating them. */
const ONNX_MESSAGES: Readonly<Record<string, Readonly<Record<number, string>>>> = {
  model: { 7: "graph", 20: "training", 25: "function" },
  graph: { 1: "node", 5: "tensor", 15: "sparse" },
  node: { 5: "attribute" },
  attribute: { 5: "tensor", 6: "graph", 10: "tensor", 11: "graph", 22: "sparse", 23: "sparse" },
  sparse: { 1: "tensor", 2: "tensor" }, training: { 1: "graph", 2: "graph" },
  function: { 7: "node", 11: "attribute" }, tensor: {}
};

/** ORT must not follow an external_data location outside the attested private tree. */
async function assertSelfContainedOnnx(file: string): Promise<void> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const size = (await handle.stat()).size;
    const buffer = Buffer.alloc(128 * 1024);
    let bufferStart = -1, bufferLength = 0, fields = 0, graphs = 0;
    async function readByte(position: number): Promise<number> {
      if (position < bufferStart || position >= bufferStart + bufferLength) {
        bufferStart = position;
        bufferLength = (await handle.read(buffer, 0, buffer.length, position)).bytesRead;
      }
      if (bufferLength === 0) throw new CoreError("VALIDATION", "invalid local ONNX protobuf");
      return buffer[position - bufferStart]!;
    }
    async function varint(cursor: { position: number }, end: number): Promise<bigint> {
      let value = 0n;
      for (let shift = 0n; shift < 70n && cursor.position < end; shift += 7n) {
        const byte = await readByte(cursor.position++);
        value |= BigInt(byte & 127) << shift;
        if (byte < 128) return value;
      }
      throw new CoreError("VALIDATION", "invalid local ONNX protobuf integer");
    }
    async function scan(kind: string, start: number, end: number, depth: number): Promise<void> {
      if (depth > 32) throw new CoreError("VALIDATION", "local ONNX graph nesting capacity exceeded");
      if (kind === "graph") graphs++;
      const cursor = { position: start };
      while (cursor.position < end) {
        if (++fields > 100000) throw new CoreError("VALIDATION", "local ONNX metadata capacity exceeded");
        const tag = Number(await varint(cursor, end));
        const field = Math.floor(tag / 8), wire = tag % 8;
        if (!field || !Number.isSafeInteger(tag)) throw new CoreError("VALIDATION", "invalid local ONNX protobuf tag");
        if (kind === "tensor" && field === 13) throw new CoreError("VALIDATION", "external-data local ONNX graphs are unsupported");
        if (wire === 0) {
          const value = await varint(cursor, end);
          if (kind === "tensor" && field === 14 && value !== 0n) throw new CoreError("VALIDATION", "external-data local ONNX graphs are unsupported");
        } else if (wire === 2) {
          const length = Number(await varint(cursor, end));
          const next = cursor.position + length;
          if (!Number.isSafeInteger(length) || next > end || next < cursor.position) throw new CoreError("VALIDATION", "invalid local ONNX protobuf length");
          const nested = ONNX_MESSAGES[kind]?.[field];
          if (nested) await scan(nested, cursor.position, next, depth + 1);
          cursor.position = next;
        } else if (wire === 1 || wire === 5) cursor.position += wire === 1 ? 8 : 4;
        else throw new CoreError("VALIDATION", "unsupported local ONNX protobuf wire type");
        if (cursor.position > end) throw new CoreError("VALIDATION", "invalid local ONNX protobuf boundary");
      }
    }
    await scan("model", 0, size, 0);
    if (graphs === 0) throw new CoreError("VALIDATION", "local ONNX model graph is missing");
  } finally { await handle.close(); }
}

function updateUint64(hash: ReturnType<typeof createHash>, value: number): void {
  const frame = Buffer.alloc(8);
  frame.writeBigUInt64BE(BigInt(value));
  hash.update(frame);
}
