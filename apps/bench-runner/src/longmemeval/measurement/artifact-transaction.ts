import { randomUUID } from "node:crypto";
import { link, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

export interface StagedDiagnosticsArtifact {
  readonly stagedPath: string;
  readonly finalPath: string;
}

export async function withPublishedDiagnosticsArtifact<T>(
  artifact: StagedDiagnosticsArtifact,
  publishArchive: () => Promise<T>,
  archiveCommitted: (error: unknown) => boolean = () => false
): Promise<T> {
  let published = false;
  try {
    await mkdir(path.dirname(artifact.finalPath), { recursive: true });
    await link(artifact.stagedPath, artifact.finalPath);
    published = true;
    await rm(artifact.stagedPath, { force: true });
    return await publishArchive();
  } catch (error) {
    if (published && !archiveCommitted(error)) {
      await rm(artifact.finalPath, { force: true });
    }
    await rm(artifact.stagedPath, { force: true });
    throw error;
  }
}

const MAX_STALE_STAGING_FILES = 8;
const MAX_STALE_STAGING_BYTES = 512 * 1024 * 1024;

export async function prepareDiagnosticsArtifactStagingPath(
  artifactRoot: string,
  label: string
): Promise<string> {
  const stagingRoot = path.join(artifactRoot, ".staging");
  await mkdir(stagingRoot, { recursive: true });
  await pruneStagingFiles(stagingRoot);
  return path.join(stagingRoot, `${safeLabel(label)}-${randomUUID()}.tmp`);
}

async function pruneStagingFiles(stagingRoot: string): Promise<void> {
  const names = await readdir(stagingRoot);
  const files = await Promise.all(names.map(async (name) => {
    const info = await stat(path.join(stagingRoot, name));
    return { name, modified: info.mtimeMs, bytes: info.size };
  }));
  files.sort((left, right) => right.modified - left.modified);
  let retainedBytes = 0;
  const stale = files.filter((file, index) => {
    retainedBytes += file.bytes;
    return index >= MAX_STALE_STAGING_FILES || retainedBytes > MAX_STALE_STAGING_BYTES;
  });
  await Promise.all(stale.map(({ name }) =>
    rm(path.join(stagingRoot, name), { force: true })
  ));
}

function safeLabel(label: string): string {
  return label.replaceAll(/[^a-zA-Z0-9._-]/gu, "-").slice(0, 96);
}
