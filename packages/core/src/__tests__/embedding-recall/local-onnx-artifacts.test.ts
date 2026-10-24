import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveLocalArtifactTreeSha256,
  snapshotLocalOnnxArtifacts,
  type VerifiedLocalOnnxArtifacts
} from "../../embedding-recall/local-onnx-artifacts.js";

const privateOnnxAllocations = vi.hoisted(() => ({
  capture: false,
  owned: [] as string[],
  concurrentUnrelated: undefined as string | undefined
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const { mkdtempSync: allocateUnrelated } = await import("node:fs");
  const { tmpdir: osTmpdir } = await import("node:os");
  const { join: joinPath } = await import("node:path");
  return {
    ...actual,
    async mkdtemp(...args: Parameters<typeof actual.mkdtemp>) {
      const allocated = await actual.mkdtemp(...args);
      if (privateOnnxAllocations.capture) {
        privateOnnxAllocations.owned.push(allocated);
        privateOnnxAllocations.concurrentUnrelated ??= allocateUnrelated(joinPath(osTmpdir(), "alaya-onnx-"));
      }
      return allocated;
    }
  };
});

const caches: string[] = [];
const snapshots: VerifiedLocalOnnxArtifacts[] = [];

afterEach(async () => {
  privateOnnxAllocations.capture = false;
  while (snapshots.length > 0) await snapshots.pop()!.dispose();
  while (caches.length > 0) rmSync(caches.pop()!, { recursive: true, force: true });
  if (privateOnnxAllocations.concurrentUnrelated !== undefined) {
    rmSync(privateOnnxAllocations.concurrentUnrelated, { recursive: true, force: true });
    privateOnnxAllocations.concurrentUnrelated = undefined;
  }
  privateOnnxAllocations.owned.length = 0;
});

describe("local ONNX artifact snapshot", () => {
  it("hashes the historical tree framing independently of cache location", async () => {
    const files: FixtureFile[] = [
      ["notes.txt", "alpha"],
      ["nested/leaf.bin", Buffer.from([1, 2, 3, 255])],
      ["nested/z.txt", "omega"]
    ];
    const first = writeTree(files);
    const second = writeTree(files);
    const golden = await goldenArtifactTreeSha256(first.modelRoot);
    expect(golden).toMatch(/^[0-9a-f]{64}$/u);
    expect(await resolveLocalArtifactTreeSha256(first.cacheRoot, first.modelId)).toBe(golden);
    expect(await resolveLocalArtifactTreeSha256(second.cacheRoot, second.modelId)).toBe(golden);
    expect(first.cacheRoot).not.toBe(second.cacheRoot);
  });

  it("keeps the private snapshot isolated from later mutation of the original cache", async () => {
    const onnx = selfContainedOnnx();
    const original = writeEncoderTree({ onnx, extra: ["notes.txt", "keep"] });
    const snapshot = await takeSnapshot(original.cacheRoot, original.modelId);
    expect(snapshot.modelRoot).not.toBe(original.modelRoot);
    expect(snapshot.weightSha256).toBe(sha256Bytes(onnx));
    expect(snapshot.treeSha256).toBe(await goldenArtifactTreeSha256(original.modelRoot));
    expect(readFileSync(join(snapshot.modelRoot, "notes.txt"), "utf8")).toBe("keep");
    writeFileSync(join(original.modelRoot, "notes.txt"), "mutated-cache");
    writeFileSync(join(original.modelRoot, "onnx/model_quantized.onnx"), Buffer.from("mutated-weights"));
    writeFileSync(join(original.modelRoot, "config.json"), JSON.stringify({ hidden_size: 1 }));
    expect(readFileSync(join(snapshot.modelRoot, "notes.txt"), "utf8")).toBe("keep");
    expect(readFileSync(join(snapshot.modelRoot, "onnx/model_quantized.onnx"))).toEqual(onnx);
    expect(snapshot.config).toEqual({ hidden_size: 384, model_type: "bert" });
    expect(snapshot.weightSha256).toBe(sha256Bytes(onnx));
    expect(snapshot.treeSha256).toBe(await goldenArtifactTreeSha256(snapshot.modelRoot));
    expect(await resolveLocalArtifactTreeSha256(original.cacheRoot, original.modelId))
      .not.toBe(snapshot.treeSha256);
  });

  it("rejects a missing or empty artifact tree", async () => {
    const cacheRoot = makeCache();
    await expect(resolveLocalArtifactTreeSha256(cacheRoot, "missing-encoder"))
      .rejects.toMatchObject({ name: "CoreError", message: "local ONNX artifact tree is missing or unreadable" });
    mkdirSync(join(cacheRoot, "empty-encoder"));
    await expect(resolveLocalArtifactTreeSha256(cacheRoot, "empty-encoder"))
      .rejects.toMatchObject({ name: "CoreError", code: "NOT_FOUND", message: "local ONNX artifact tree is missing or unreadable" });
    await expect(snapshotLocalOnnxArtifacts(cacheRoot, "missing-encoder")).rejects.toThrow();
  });

  it("rejects symbolic links in the artifact tree", async () => {
    const original = writeEncoderTree({ onnx: selfContainedOnnx() });
    const outside = join(makeCache(), "outside.json");
    writeFileSync(outside, "{\"escaped\":true}");
    rmSync(join(original.modelRoot, "config.json"));
    symlinkSync(outside, join(original.modelRoot, "config.json"));
    await expect(snapshotLocalOnnxArtifacts(original.cacheRoot, original.modelId))
      .rejects.toMatchObject({
        name: "CoreError",
        code: "VALIDATION",
        message: "local ONNX artifact tree must not contain symbolic links"
      });
  });

  it("rejects a model id that escapes the cache root", async () => {
    const cacheRoot = makeCache();
    await expect(resolveLocalArtifactTreeSha256(cacheRoot, "..")).rejects.toMatchObject({
      name: "CoreError",
      code: "VALIDATION",
      message: "local ONNX model id must stay within the cache root"
    });
    await expect(snapshotLocalOnnxArtifacts(cacheRoot, "/tmp/abs-encoder")).rejects.toMatchObject({
      name: "CoreError",
      code: "VALIDATION",
      message: "local ONNX model id must stay within the cache root"
    });
  });

  it("rejects an external-data ONNX graph", async () => {
    const original = writeEncoderTree({ onnx: externalDataOnnx() });
    await expect(snapshotLocalOnnxArtifacts(original.cacheRoot, original.modelId))
      .rejects.toMatchObject({
        name: "CoreError",
        code: "VALIDATION",
        message: "external-data local ONNX graphs are unsupported"
      });
  });

  it("allocates the copy beneath the fork-owned parent without disposing its siblings", async () => {
    const original = writeEncoderTree({ onnx: selfContainedOnnx() });
    const parent = makeCache();
    const sibling = join(parent, "unrelated");
    writeFileSync(sibling, "keep");
    vi.stubEnv("ALAYA_LOCAL_ONNX_SNAPSHOT_PARENT", parent);
    try {
      const snapshot = await takeSnapshot(original.cacheRoot, original.modelId);
      expect(dirname(dirname(snapshot.modelRoot))).toBe(parent);
      await snapshot.dispose();
      expect(readFileSync(sibling, "utf8")).toBe("keep");
      expect(existsSync(parent)).toBe(true);
    } finally { vi.unstubAllEnvs(); }
  });

  it("removes the private tree after a normal dispose", async () => {
    const original = writeEncoderTree({ onnx: selfContainedOnnx() });
    const snapshot = await takeSnapshot(original.cacheRoot, original.modelId);
    const privateRoot = dirname(snapshot.modelRoot);
    expect(existsSync(snapshot.modelRoot)).toBe(true);
    await snapshot.dispose();
    await snapshot.dispose();
    expect(existsSync(snapshot.modelRoot)).toBe(false);
    expect(existsSync(privateRoot)).toBe(false);
    expect(existsSync(join(original.modelRoot, "onnx/model_quantized.onnx"))).toBe(true);
  });

  it("removes the private tree when snapshot validation fails", async () => {
    const original = writeEncoderTree({ onnx: selfContainedOnnx() });
    rmSync(join(original.modelRoot, "onnx/model_quantized.onnx"));
    privateOnnxAllocations.owned.length = 0;
    privateOnnxAllocations.concurrentUnrelated = undefined;
    privateOnnxAllocations.capture = true;
    try {
      await expect(snapshotLocalOnnxArtifacts(original.cacheRoot, original.modelId)).rejects.toThrow();
    } finally {
      privateOnnxAllocations.capture = false;
    }
    expect(privateOnnxAllocations.owned.length).toBeGreaterThanOrEqual(1);
    expect(privateOnnxAllocations.owned).toHaveLength(1);
    const owned = privateOnnxAllocations.owned[0]!;
    const concurrentUnrelated = privateOnnxAllocations.concurrentUnrelated;
    expect(concurrentUnrelated).toEqual(expect.any(String));
    expect(concurrentUnrelated).not.toBe(owned);
    expect(existsSync(owned)).toBe(false);
    expect(existsSync(concurrentUnrelated!)).toBe(true);
    expect(existsSync(original.modelRoot)).toBe(true);
  });
});

type FixtureFile = readonly [string, string | Buffer];

function makeCache(): string {
  const cacheRoot = mkdtempSync(join(tmpdir(), "alaya-onnx-cache-"));
  caches.push(cacheRoot);
  return cacheRoot;
}

function writeTree(files: readonly FixtureFile[], modelId = "fixture-tree"): {
  cacheRoot: string;
  modelId: string;
  modelRoot: string;
} {
  const cacheRoot = makeCache();
  const modelRoot = join(cacheRoot, modelId);
  for (const [relativePath, contents] of files) {
    const file = join(modelRoot, relativePath);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }
  return { cacheRoot, modelId, modelRoot };
}

function writeEncoderTree(options: { onnx: Buffer; extra?: FixtureFile }): {
  cacheRoot: string;
  modelId: string;
  modelRoot: string;
} {
  const files: FixtureFile[] = [
    ["onnx/model_quantized.onnx", options.onnx],
    ["config.json", JSON.stringify({ hidden_size: 384, model_type: "bert" })],
    ["tokenizer_config.json", "{}"],
    ["tokenizer.json", "{}"],
    ["special_tokens_map.json", "{}"]
  ];
  if (options.extra) files.push(options.extra);
  return writeTree(files, "fixture-encoder");
}

async function takeSnapshot(cacheRoot: string, modelId: string): Promise<VerifiedLocalOnnxArtifacts> {
  const snapshot = await snapshotLocalOnnxArtifacts(cacheRoot, modelId);
  snapshots.push(snapshot);
  return snapshot;
}

/** Independent of resolveLocalArtifactTreeSha256: prefix, UTF-8 path frames, BE uint64 sizes, raw bytes. */
async function goldenArtifactTreeSha256(root: string): Promise<string> {
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => Buffer.compare(Buffer.from(left.name, "utf8"), Buffer.from(right.name, "utf8")));
    for (const entry of entries) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) files.push(file);
      else throw new Error(`golden walk requires files and directories: ${file}`);
    }
  }
  await walk(root);
  const hash = createHash("sha256").update("alaya-local-onnx-tree-v1\0", "utf8");
  for (const file of files) {
    const relativePath = Buffer.from(relative(root, file), "utf8");
    const bytes = await readFile(file);
    hash.update(uint64be(relativePath.byteLength));
    hash.update(relativePath);
    hash.update(uint64be(bytes.byteLength));
    hash.update(bytes);
  }
  return hash.digest("hex");
}

function uint64be(value: number): Buffer {
  const frame = Buffer.alloc(8);
  frame.writeBigUInt64BE(BigInt(value));
  return frame;
}

function sha256Bytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    bytes.push((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  bytes.push(rest);
  return Buffer.from(bytes);
}

function lengthDelimited(field: number, payload: Buffer): Buffer {
  return Buffer.concat([encodeVarint((field << 3) | 2), encodeVarint(payload.byteLength), payload]);
}

/** Structurally valid ModelProto with a GraphProto and no tensor payloads. */
function selfContainedOnnx(): Buffer {
  return lengthDelimited(7, Buffer.alloc(0));
}

/** Graph initializer TensorProto field 13 (external_data) — rejected by graph validation. */
function externalDataOnnx(): Buffer {
  const tensor = lengthDelimited(13, Buffer.from("weights.bin", "utf8"));
  return lengthDelimited(7, lengthDelimited(5, tensor));
}
