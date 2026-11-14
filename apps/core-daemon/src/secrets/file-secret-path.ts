import path from "node:path";
import { isContainedFileSecretPath } from "@do-soul/alaya-protocol";

/** Admission shared by config writers and the runtime file-secret reader. */
export function resolveContainedFileSecretPath(filePath: string, secretsDir: string): string | null {
  if (!path.isAbsolute(filePath) || filePath.includes("\0")) return null;
  const resolved = path.resolve(filePath);
  return isContainedFileSecretPath(resolved, path.resolve(secretsDir)) ? resolved : null;
}
