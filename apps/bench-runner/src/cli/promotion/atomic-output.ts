import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, open, realpath, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";

export async function publishExclusiveAuthorization(
  outputPath: string,
  contents: string
): Promise<string> {
  const absolutePath = path.resolve(outputPath);
  const outputRoot = await realpath(path.dirname(absolutePath));
  const target = path.join(outputRoot, path.basename(absolutePath));
  const temp = path.join(
    outputRoot,
    `.${path.basename(absolutePath)}.tmp-${process.pid}-${randomUUID()}`
  );
  let handle: FileHandle | undefined;
  try {
    handle = await open(temp, exclusiveWriteFlags(), 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temp, target);
    await unlink(temp);
    return target;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temp).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`authorization output already exists: ${outputPath}`);
    }
    throw error;
  }
}

function exclusiveWriteFlags(): number {
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw new Error("descriptor-safe authorization output is unavailable");
  }
  return constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
}
