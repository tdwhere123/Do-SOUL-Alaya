import { CoreError } from "@do-soul/alaya-core";

export function assertPasteSecretSupported(platform: NodeJS.Platform): void {
  if (platform === "win32") {
    throw new CoreError("VALIDATION", "paste mode is not supported on win32");
  }
}
