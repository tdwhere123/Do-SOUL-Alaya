import fs from "node:fs";
import path from "node:path";
import { resolveTemporalResourcePath } from "./temporal-resource-path.js";

/** The link exists, but publication durability could not be acknowledged. */
export class TemporalFilePublicationError extends Error {
  public constructor(public readonly publishedFilename: string, cause: unknown) {
    super(`Temporal output was linked but directory sync failed: ${publishedFilename}`, { cause });
    this.name = "TemporalFilePublicationError";
  }
}

/** A reserved candidate name remains established even if its database is lost. */
export function temporalEstablishedMarker(filename: string): string {
  return `${resolveTemporalResourcePath(filename)}.temporal-established`;
}

export function syncTemporalDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, "r");
  try { fs.fsyncSync(descriptor); }
  catch (error) {
    // Node's Windows directory handles cannot be flushed. File contents are still
    // synced, but directory-entry crash durability is only available on POSIX.
    if (process.platform !== "win32" || !(error instanceof Error) ||
        !("code" in error) || error.code !== "EPERM") throw error;
  }
  finally { fs.closeSync(descriptor); }
}

/** Publish only complete, durable contents without replacing another owner's output. */
export function publishNewTemporalFile(staging: string, destination: string): void {
  fs.chmodSync(staging, 0o600);
  // Windows FlushFileBuffers requires write access; r+ does not truncate contents.
  const descriptor = fs.openSync(staging, "r+");
  try { fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
  fs.linkSync(staging, destination);
  try {
    syncTemporalDirectory(path.dirname(destination));
  } catch (error) {
    throw new TemporalFilePublicationError(destination, error);
  }
}

/** This witnesses an established filename, never selection or schema readiness. */
export function markTemporalDatabaseEstablished(filename: string): void {
  const marker = temporalEstablishedMarker(filename);
  let descriptor: number;
  try {
    descriptor = fs.openSync(marker, "wx", 0o600);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    const existing = fs.openSync(marker, "r+");
    try { fs.fsyncSync(existing); }
    finally { fs.closeSync(existing); }
    syncTemporalDirectory(path.dirname(marker));
    return;
  }
  try {
    fs.writeFileSync(descriptor, "Established temporal database; absence requires explicit recovery.\n");
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
  syncTemporalDirectory(path.dirname(marker));
}
