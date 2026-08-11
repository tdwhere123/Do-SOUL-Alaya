import { randomUUID } from "node:crypto";
import { link, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { throwLifecycleErrors } from "../lifecycle/errors.js";

export interface StagedDiagnosticsArtifact {
  readonly stagedPath: string;
  readonly finalPath: string;
}

interface ArtifactTransactionOperations {
  readonly remove: typeof rm;
}

const artifactTransactionOperations: ArtifactTransactionOperations = {
  remove: rm
};

export async function withPublishedDiagnosticsArtifact<T>(
  artifact: StagedDiagnosticsArtifact,
  publishArchive: () => Promise<T>,
  archiveCommitted: (error: unknown) => boolean = () => false,
  operations: ArtifactTransactionOperations = artifactTransactionOperations
): Promise<T> {
  let published = false;
  try {
    await mkdir(path.dirname(artifact.finalPath), { recursive: true });
    await link(artifact.stagedPath, artifact.finalPath);
    published = true;
    await operations.remove(artifact.stagedPath, { force: true });
    return await publishArchive();
  } catch (error) {
    const cleanupErrors = await cleanFailedPublication(
      artifact, published && !archiveCommitted(error), operations
    );
    throwLifecycleErrors("Diagnostics artifact publication failed", [
      error,
      ...cleanupErrors
    ]);
    throw error;
  }
}

async function cleanFailedPublication(
  artifact: StagedDiagnosticsArtifact,
  removeFinal: boolean,
  operations: ArtifactTransactionOperations
): Promise<unknown[]> {
  const errors: unknown[] = [];
  if (removeFinal) {
    try {
      await operations.remove(artifact.finalPath, { force: true });
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await operations.remove(artifact.stagedPath, { force: true });
  } catch (error) {
    errors.push(error);
  }
  return errors;
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
