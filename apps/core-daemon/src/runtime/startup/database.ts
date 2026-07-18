import { initDatabase } from "@do-soul/alaya-storage";

export function openDaemonDatabase(filename: string) {
  return initDatabase({ filename });
}
