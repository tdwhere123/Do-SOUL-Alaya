import { existsSync, lstatSync } from "node:fs";
import { resolve } from "node:path";
import { OBSOLETE_DEEPSEEK_REQUEST_PROFILE } from "./profile.js";

export function retireObsoleteDeepseekCache(input: {
  readonly cacheRoot: string;
  readonly expectedPath: string;
  readonly confirm: boolean;
  readonly lockPath?: string;
}): {
  readonly retired: false;
  readonly profile: typeof OBSOLETE_DEEPSEEK_REQUEST_PROFILE;
  readonly reason: string;
} {
  if (!input.confirm) {
    throw new Error("DeepSeek cache retirement requires an explicit confirm flag");
  }
  const cacheRoot = resolve(input.cacheRoot);
  const expected = resolve(input.expectedPath);
  if (cacheRoot !== expected) {
    throw new Error("DeepSeek cache retirement path does not match the expected root");
  }
  if (!existsSync(cacheRoot) || !lstatSync(cacheRoot).isDirectory()) {
    throw new Error("DeepSeek cache retirement target is not a directory");
  }
  const lockPath = input.lockPath ?? resolve(cacheRoot, ".extraction-fill.lock");
  if (existsSync(lockPath)) {
    throw new Error("DeepSeek cache retirement refuses an in-progress extraction lock");
  }
  return {
    retired: false,
    profile: OBSOLETE_DEEPSEEK_REQUEST_PROFILE,
    reason: "preflight passed; deletion is operator-owned and not executed here"
  };
}
