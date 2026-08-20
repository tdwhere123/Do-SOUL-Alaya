import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ProfileMutationFs } from "./profile-mutation-types.js";
import { isNodeError } from "./profile-mutation-text.js";

export function createNodeProfileMutationFs(): ProfileMutationFs {
  return {
    async readText(filePath) {
      try {
        return await readFile(filePath, "utf8");
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          return undefined;
        }
        throw error;
      }
    },
    async writeTextAtomic(filePath, content, mode = 0o600) {
      await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
      const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tempPath, content, { mode });
      await rename(tempPath, filePath);
    },
    async removeText(filePath) {
      try {
        await unlink(filePath);
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") {
          throw error;
        }
      }
    }
  };
}
