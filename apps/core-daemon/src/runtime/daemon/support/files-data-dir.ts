import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function resolveCoreDaemonFilesDirectory(): string {
  const currentDirectory = dirname(fileURLToPath(import.meta.url));
  return resolve(currentDirectory, "../data/files");
}
