import { existsSync, lstatSync } from "node:fs";
import { resolve } from "node:path";
import {
  isObsoleteRequestProfile,
  type ObsoleteRequestProfile
} from "./catalog.js";

export function retireObsoleteCache(input: {
  readonly cacheRoot: string;
  readonly expectedPath: string;
  readonly confirm: boolean;
  readonly profile: string;
  readonly lockPath?: string;
}): {
  readonly retired: false;
  readonly profile: ObsoleteRequestProfile;
  readonly reason: string;
} {
  if (!input.confirm) {
    throw new Error("obsolete cache retirement requires an explicit confirm flag");
  }
  if (!isObsoleteRequestProfile(input.profile)) {
    throw new Error(`profile ${input.profile} is not marked obsolete`);
  }
  const cacheRoot = resolve(input.cacheRoot);
  const expected = resolve(input.expectedPath);
  if (cacheRoot !== expected) {
    throw new Error("obsolete cache retirement path does not match the expected root");
  }
  if (!existsSync(cacheRoot) || !lstatSync(cacheRoot).isDirectory()) {
    throw new Error("obsolete cache retirement target is not a directory");
  }
  const lockPath = input.lockPath ?? resolve(cacheRoot, ".extraction-fill.lock");
  if (existsSync(lockPath)) {
    throw new Error("obsolete cache retirement refuses an in-progress extraction lock");
  }
  return {
    retired: false,
    profile: input.profile,
    reason: "preflight passed; deletion is operator-owned and not executed here"
  };
}
