import { resolve } from "node:path";
import { resolveCoreDaemonPackageRoot } from "./build-info.js";

export function resolveCoreDaemonFilesDirectory(moduleUrl: string = import.meta.url): string {
  return resolve(resolveCoreDaemonPackageRoot(moduleUrl), "data", "files");
}
