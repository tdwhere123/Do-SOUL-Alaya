import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

interface ReadGardenLlmJsonCacheOptions<T> {
  readonly cacheRoot: string;
  readonly requestKey: string;
  readonly warningMessage: string;
  readonly warningCode: string;
  parseEntry(parsed: unknown, requestKey: string): T | undefined;
}

export function gardenLlmCacheFilePath(cacheRoot: string, requestKey: string): string {
  return join(cacheRoot, requestKey.slice(0, 2), `${requestKey}.json`);
}

export async function readGardenLlmJsonCache<T>(
  options: ReadGardenLlmJsonCacheOptions<T>
): Promise<T | undefined> {
  const filePath = gardenLlmCacheFilePath(options.cacheRoot, options.requestKey);
  if (!(await fileExists(filePath))) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
    return options.parseEntry(parsed, options.requestKey);
  } catch (error) {
    process.emitWarning(options.warningMessage, {
      code: options.warningCode,
      detail: JSON.stringify({
        path: filePath,
        code: (error as NodeJS.ErrnoException)?.code ?? (error instanceof Error ? error.name : "unknown")
      })
    });
    return undefined;
  }
}

export async function writeGardenLlmJsonCache(
  cacheRoot: string,
  requestKey: string,
  entry: unknown
): Promise<void> {
  const filePath = gardenLlmCacheFilePath(cacheRoot, requestKey);
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
