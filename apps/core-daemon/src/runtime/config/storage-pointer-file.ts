import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, link, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { syncDirectory } from "../../services/private-file-service.js";

/** Writes a complete configuration file by rename so a daemon never observes a torn pointer. */
export async function writeTextAtomic(filePath: string, content: string, mode: number): Promise<void> {
  const normalizedPath = path.resolve(filePath);
  const tempPath = await writeSyncedTempFile(normalizedPath, content, mode);
  try {
    await rename(tempPath, normalizedPath);
    await chmod(normalizedPath, mode);
    await syncDirectory(path.dirname(normalizedPath));
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

/** Creates a journal exactly once without publishing a partial file or replacing an existing one. */
export async function writeNewTextAtomic(filePath: string, content: string, mode: number): Promise<void> {
  const normalizedPath = path.resolve(filePath);
  const tempPath = await writeSyncedTempFile(normalizedPath, content, mode);
  try {
    await link(tempPath, normalizedPath);
    await syncDirectory(path.dirname(normalizedPath));
  } finally {
    await unlink(tempPath).catch(() => undefined);
  }
}

async function writeSyncedTempFile(filePath: string, content: string, mode: number): Promise<string> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const tempPath = path.join(directory, `.tmp-${path.basename(filePath)}-${randomUUID()}`);
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(
    tempPath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollow,
    mode
  );
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
  await handle.close();
  return tempPath;
}

/** Preserves unrelated TOML text while replacing the one runtime storage pointer. */
export function replaceStorageDbPathInToml(tomlContent: string, dbPath: string): string {
  const lines = tomlContent.split(/\r?\n/u);
  const output: string[] = [];
  let section: string | null = null;
  let storageSectionSeen = false;
  let storageDbPathWritten = false;

  for (const rawLine of lines) {
    const sectionMatch = rawLine.trim().match(/^\[(.+)\]$/u);
    if (sectionMatch !== null) {
      if (section === "storage" && !storageDbPathWritten) {
        output.push(`db_path = ${quoteTomlString(dbPath)}`);
        storageDbPathWritten = true;
      }
      section = sectionMatch[1]?.trim() ?? null;
      if (section === "storage") {
        storageSectionSeen = true;
      }
      output.push(rawLine);
      continue;
    }

    if (section === "storage" && rawLine.trim().match(/^db_path\s*=/u)) {
      if (!storageDbPathWritten) {
        output.push(`db_path = ${quoteTomlString(dbPath)}`);
        storageDbPathWritten = true;
      }
      continue;
    }

    output.push(rawLine);
  }

  if (storageSectionSeen && !storageDbPathWritten) {
    output.push(`db_path = ${quoteTomlString(dbPath)}`);
  }

  if (!storageSectionSeen) {
    if (output.length > 0 && output.at(-1) !== "") {
      output.push("");
    }
    output.push("[storage]", `db_path = ${quoteTomlString(dbPath)}`);
  }

  return `${output.join("\n").replace(/\n+$/u, "")}\n`;
}

function quoteTomlString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}
