import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { CoreError } from "@do-soul/alaya-core";

export async function ensurePrivateDirectory(directoryPath: string): Promise<void> {
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const stats = await lstat(directoryPath);
  if (!stats.isDirectory()) {
    throw new CoreError("CONFLICT", `Private config path is not a directory: ${directoryPath}`);
  }
  await chmod(directoryPath, 0o700);
}

export async function writePrivateTextAtomic(
  filePath: string,
  content: string,
  mode: number,
  generateTempId: () => string = () => randomUUID()
): Promise<void> {
  await ensurePrivateDirectory(path.dirname(filePath));
  const tempPath = `${filePath}.${generateTempId()}.tmp`;
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(
    tempPath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollow,
    mode
  );
  let closed = false;
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    closed = true;
    await rename(tempPath, filePath);
    await chmod(filePath, mode);
    await syncDirectory(path.dirname(filePath));
  } catch (error) {
    if (!closed) {
      await handle.close().catch(() => undefined);
    }
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

export async function syncDirectory(directoryPath: string): Promise<void> {
  try {
    const handle = await open(directoryPath, fsConstants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Some filesystems do not support fsync on directories; exclusive temp
    // creation plus rename still preserves the write contract.
  }
}

export function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
