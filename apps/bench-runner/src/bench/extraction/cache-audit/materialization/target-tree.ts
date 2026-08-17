import {
  existsSync, lstatSync, readdirSync, realpathSync, rmdirSync
} from "node:fs";
import { join, relative } from "node:path";
import { cacheFilePath } from "../../../compile-seed/compile-seed-cache.js";
import { fsyncDirectory } from
  "../../fill/manifest/durable-exclusive-publication.js";
import {
  MATERIALIZATION_COMMIT_NAME, MATERIALIZATION_JOURNAL_NAME,
  MATERIALIZATION_STAGE_NAME, type MaterializationShardDescriptor
} from "./contract.js";
import {
  readStableRegularFileNoFollow, type StableFileIdentity
} from "./descriptor-io.js";
import { isStableLeasePath } from "../../fill/manifest/fill-root-guard.js";

const TARGET_MARKER = ".alaya-extraction-target-root.json";
const WRITE_LOCK = ".extraction-fill.lock";

export type MaterializationTreeState = "fresh" | "open" | "manifest" | "committed";

export function assertRecoverableTargetTree(
  targetRoot: string,
  descriptors: readonly MaterializationShardDescriptor[],
  maxShardBytes: number
): void {
  const byKey = new Map(descriptors.map((descriptor) => [descriptor.cache_key, descriptor]));
  for (const entry of readdirSync(targetRoot, { withFileTypes: true })) {
    if (/^[a-f0-9]{2}$/u.test(entry.name)) {
      assertRecoverablePrefix(targetRoot, entry.name, byKey, maxShardBytes);
      continue;
    }
    if (entry.name === MATERIALIZATION_STAGE_NAME) {
      assertRecoverableStage(targetRoot, byKey, maxShardBytes);
      continue;
    }
    if (![TARGET_MARKER, WRITE_LOCK, MATERIALIZATION_JOURNAL_NAME, "manifest.json"]
      .includes(entry.name) || entry.isSymbolicLink()) {
      throw new Error("target contains an unknown entry during materialization recovery");
    }
    if (entry.name === "manifest.json" && !entry.isFile()) {
      throw new Error("target manifest is not a regular file");
    }
  }
}

function assertRecoverablePrefix(
  targetRoot: string,
  prefix: string,
  byKey: ReadonlyMap<string, MaterializationShardDescriptor>,
  maxShardBytes: number
): void {
  assertPrefixTree(targetRoot, prefix, new Set(byKey.keys()), false);
  for (const child of readdirSync(join(targetRoot, prefix))) {
    const descriptor = byKey.get(child.slice(0, -5));
    if (descriptor === undefined) throw new Error("target shard tree contains an unknown entry");
    assertFileMatches(join(targetRoot, prefix, child), descriptor, maxShardBytes);
  }
}

function assertRecoverableStage(
  targetRoot: string,
  byKey: ReadonlyMap<string, MaterializationShardDescriptor>,
  maxShardBytes: number
): void {
  const stageRoot = join(targetRoot, MATERIALIZATION_STAGE_NAME);
  assertRealDirectory(stageRoot, "materialization stage");
  for (const entry of readdirSync(stageRoot, { withFileTypes: true })) {
    const key = entry.name.replace(/\.json$/u, "");
    if (!entry.isFile() || entry.isSymbolicLink() || !byKey.has(key) ||
        entry.name !== `${key}.json`) {
      throw new Error("materialization stage contains an unknown entry");
    }
    assertRecoverableStageFile(join(stageRoot, entry.name), maxShardBytes);
  }
}

export function assertExactTargetTree(
  targetRoot: string,
  descriptors: readonly MaterializationShardDescriptor[],
  state: MaterializationTreeState
): void {
  const expectedKeys = new Set(descriptors.map((descriptor) => descriptor.cache_key));
  const allowedRoot = allowedRootEntries(state);
  for (const entry of readdirSync(targetRoot, { withFileTypes: true })) {
    if (/^[a-f0-9]{2}$/u.test(entry.name)) {
      if (![...expectedKeys].some((key) => key.startsWith(entry.name))) {
        throw new Error("target contains an unexpected empty shard prefix");
      }
      assertPrefixTree(targetRoot, entry.name, expectedKeys, state === "fresh");
    } else if (!allowedRoot.has(entry.name) || entry.isSymbolicLink()) {
      throw new Error("target contains an unknown entry or open materialization stage");
    }
  }
  if (state !== "fresh") assertExpectedFilesExist(targetRoot, descriptors);
}

function allowedRootEntries(state: MaterializationTreeState): Set<string> {
  const allowed = new Set([TARGET_MARKER, WRITE_LOCK]);
  if (state !== "fresh") allowed.add(MATERIALIZATION_JOURNAL_NAME);
  if (state === "manifest" || state === "committed") allowed.add("manifest.json");
  if (state === "committed") {
    allowed.add(MATERIALIZATION_COMMIT_NAME);
    allowed.delete(MATERIALIZATION_JOURNAL_NAME);
  }
  return allowed;
}

function assertExpectedFilesExist(
  targetRoot: string,
  descriptors: readonly MaterializationShardDescriptor[]
): void {
  for (const descriptor of descriptors) {
    if (!existsSync(cacheFilePath(targetRoot, descriptor.cache_key))) {
      throw new Error("target materialization tree is incomplete");
    }
  }
}

function assertPrefixTree(
  targetRoot: string,
  prefix: string,
  expectedKeys: ReadonlySet<string>,
  requireEmpty: boolean
): void {
  const path = join(targetRoot, prefix);
  assertRealDirectory(path, "target shard prefix");
  const children = readdirSync(path, { withFileTypes: true });
  if (requireEmpty && children.length > 0) throw new Error("partial target requires a journal");
  for (const child of children) {
    const key = child.name.replace(/\.json$/u, "");
    if (!child.isFile() || child.isSymbolicLink() || !expectedKeys.has(key) ||
        relative(targetRoot, join(path, child.name)) !== `${prefix}/${key}.json`) {
      throw new Error("target shard tree contains an unknown or unsafe entry");
    }
  }
}

export function assertFileMatches(
  path: string,
  descriptor: MaterializationShardDescriptor,
  maxShardBytes: number
): void {
  if (!isStableLeasePath(path) && realpathSync(path) !== path) {
    throw new Error("materialized shard path is not canonical");
  }
  const read = readStableRegularFileNoFollow(path, maxShardBytes);
  if (!isDescriptorMatch(read.identity, descriptor)) {
    throw new Error("materialized shard differs from its journal descriptor");
  }
}

export function assertRecoverableStageFile(path: string, maxShardBytes: number): void {
  readRecoverableStageFile(path, maxShardBytes);
}

export function readRecoverableStageFile(
  path: string,
  maxShardBytes: number
): ReturnType<typeof readStableRegularFileNoFollow> {
  if (!isStableLeasePath(path) && realpathSync(path) !== path) {
    throw new Error("materialization stage path is not canonical");
  }
  return readStableRegularFileNoFollow(path, maxShardBytes);
}

export function isDescriptorMatch(
  identity: StableFileIdentity,
  descriptor: MaterializationShardDescriptor
): boolean {
  return identity.sha256 === descriptor.file_sha256 &&
    identity.byteLength === descriptor.byte_length;
}

export function removeEmptyStage(targetRoot: string): void {
  const path = join(targetRoot, MATERIALIZATION_STAGE_NAME);
  if (!existsSync(path)) return;
  assertRealDirectory(path, "materialization stage");
  if (readdirSync(path).length !== 0) throw new Error("materialization stage is not empty");
  rmdirSync(path);
  fsyncDirectory(targetRoot);
}

export function assertRealDirectory(path: string, label: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      (!isStableLeasePath(path) && realpathSync(path) !== path)) {
    throw new Error(`${label} must be a canonical non-symlink directory`);
  }
}
