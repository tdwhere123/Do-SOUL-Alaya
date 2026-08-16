import { randomUUID } from "node:crypto";
import { link, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { throwLifecycleErrors } from "../lifecycle/errors.js";

const STAGING_SESSION_NAME = `${process.pid}-${randomUUID()}`;

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

export async function prepareDiagnosticsArtifactStagingPath(
  artifactRoot: string,
  label: string
): Promise<string> {
  const stagingRoot = path.join(artifactRoot, ".staging");
  const sessionRoot = path.join(stagingRoot, STAGING_SESSION_NAME);
  await mkdir(sessionRoot, { recursive: true });
  await pruneAbandonedStagingSessions(stagingRoot);
  return path.join(sessionRoot, `${safeLabel(label)}-${randomUUID()}.tmp`);
}

async function pruneAbandonedStagingSessions(stagingRoot: string): Promise<void> {
  const entries = await readdir(stagingRoot, { withFileTypes: true });
  const abandoned = entries.filter((entry) => {
    if (!entry.isDirectory() || entry.name === STAGING_SESSION_NAME) return false;
    const ownerPid = stagingSessionOwnerPid(entry.name);
    return ownerPid !== null && !isProcessAlive(ownerPid);
  });
  await Promise.all(abandoned.map((entry) =>
    rm(path.join(stagingRoot, entry.name), { recursive: true, force: true })
  ));
}

function stagingSessionOwnerPid(name: string): number | null {
  const separator = name.indexOf("-");
  if (separator < 1 || !/^[0-9]+$/u.test(name.slice(0, separator))) return null;
  const pid = Number(name.slice(0, separator));
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function safeLabel(label: string): string {
  return label.replaceAll(/[^a-zA-Z0-9._-]/gu, "-").slice(0, 96);
}
