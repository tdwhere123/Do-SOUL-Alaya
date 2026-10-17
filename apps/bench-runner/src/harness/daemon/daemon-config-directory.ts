import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface BenchDaemonConfigDirectoryLease {
  readonly path: string;
  readonly prepare: () => Promise<void>;
  readonly cleanup: () => Promise<void>;
}

export function planBenchDaemonConfigDirectory(root?: string): string {
  const directory = root === undefined ? tmpdir() : resolveBenchDaemonConfigRoot(root);
  return join(directory, `alaya-bench-config-${randomUUID()}`);
}

export function resolveBenchDaemonConfigRoot(root: string): string {
  if (typeof root !== "string" || root.trim().length === 0 || !lstatSync(root).isDirectory()) {
    throw new Error("bench config root must be an existing directory");
  }
  return realpathSync(root);
}

export function createBenchDaemonConfigDirectoryLease(
  path: string
): BenchDaemonConfigDirectoryLease {
  let state: "planned" | "prepared" | "cleaned" = "planned";
  return Object.freeze({
    path,
    prepare: async (): Promise<void> => {
      if (state === "prepared") return;
      if (state === "cleaned") {
        throw new Error("bench daemon config directory lease is already cleaned");
      }
      await mkdir(path, { mode: 0o700 });
      state = "prepared";
    },
    cleanup: async (): Promise<void> => {
      if (state === "cleaned") return;
      if (state === "prepared") {
        await rm(path, { recursive: true, force: true });
      }
      state = "cleaned";
    }
  });
}
