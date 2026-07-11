import { access, mkdir, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { removeTempDirectory } from "./temp-directory-cleanup.js";

const FAILED_ROOT_KEEP_COUNT = 3;
const FAILED_ROOT_MAX_BYTES = 512 * 1024 * 1024;

export interface OwnedTempRoot {
  readonly path: string;
  readonly owned: boolean;
}

export async function createOwnedTempRoot(prefix: string): Promise<OwnedTempRoot> {
  return Object.freeze({
    path: await mkdtemp(join(tmpdir(), prefix)),
    owned: true
  });
}

export function externalTempRoot(path: string): OwnedTempRoot {
  return Object.freeze({ path, owned: false });
}

export async function finalizeOwnedTempRoot(
  root: OwnedTempRoot,
  succeeded: boolean,
  warn: (message: string) => void = (message) => process.stderr.write(`${message}\n`)
): Promise<void> {
  if (!root.owned) return;
  if (!succeeded) {
    await boundFailedRoot(root.path);
    await ensureFailedRootMarker(root.path);
    await pruneOlderFailedRoots(root.path);
    warn(`[bench temp-root] retained failed run evidence at ${root.path}`);
    return;
  }
  await removeTempDirectory(root.path);
}

async function ensureFailedRootMarker(rootPath: string): Promise<void> {
  const marker = join(rootPath, "FAILED_RUN_EVIDENCE.txt");
  try {
    await access(marker);
  } catch {
    await writeFile(marker, "Retained failed benchmark run evidence.\n", "utf8");
  }
}

async function boundFailedRoot(rootPath: string): Promise<void> {
  if (await treeSizeBytes(rootPath) <= FAILED_ROOT_MAX_BYTES) return;
  await removeTempDirectory(rootPath);
  await mkdir(rootPath, { recursive: true });
  await writeFile(
    join(rootPath, "FAILED_RUN_EVIDENCE.txt"),
    `Database evidence exceeded ${FAILED_ROOT_MAX_BYTES} bytes and was pruned.\n`,
    "utf8"
  );
}

async function pruneOlderFailedRoots(rootPath: string): Promise<void> {
  const parent = dirname(rootPath);
  const stem = basename(rootPath).slice(0, -6);
  const inspected = await Promise.all(
    (await readdir(parent, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(stem))
      .map(async (entry) => inspectFailedRoot(join(parent, entry.name)))
  );
  const candidates = inspected.filter(
    (entry): entry is { readonly path: string; readonly mtimeMs: number } => entry !== null
  );
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  await Promise.all(
    candidates.slice(FAILED_ROOT_KEEP_COUNT).map((entry) =>
      removeTempDirectory(entry.path)
    )
  );
}

async function inspectFailedRoot(
  path: string
): Promise<{ readonly path: string; readonly mtimeMs: number } | null> {
  try {
    await access(join(path, "FAILED_RUN_EVIDENCE.txt"));
    return { path, mtimeMs: (await stat(path)).mtimeMs };
  } catch {
    return null;
  }
}

async function treeSizeBytes(rootPath: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(rootPath, { withFileTypes: true })) {
    const path = join(rootPath, entry.name);
    total += entry.isDirectory() ? await treeSizeBytes(path) : (await stat(path)).size;
    if (total > FAILED_ROOT_MAX_BYTES) return total;
  }
  return total;
}
