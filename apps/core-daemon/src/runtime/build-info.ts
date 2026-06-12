import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface BuildInfo {
  readonly version: string;
  readonly git_head: string;
  readonly built_at: string;
}

const UNKNOWN_BUILD_INFO: BuildInfo = {
  version: "0.0.0-dev",
  git_head: "unknown",
  built_at: "unknown"
};

// dist/build-info.json is written by scripts/build-existing.mjs at the end
// of every build. When doctor / daemon import this module from a built tree
// (dist/build-info.js), import.meta.url resolves to dist/, so the JSON
// sibling is one level up by the same name. From source (tests, ts-node),
// import.meta.url is the .ts and build-info.json does not exist — readBuildInfo
// returns the unknown sentinel so the doctor row still renders.
export function readBuildInfo(): BuildInfo {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidatePath = resolve(here, "build-info.json");
    const raw = readFileSync(candidatePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<BuildInfo>;
    return {
      version:
        typeof parsed.version === "string" && parsed.version.length > 0
          ? parsed.version
          : UNKNOWN_BUILD_INFO.version,
      git_head:
        typeof parsed.git_head === "string" && parsed.git_head.length > 0
          ? parsed.git_head
          : UNKNOWN_BUILD_INFO.git_head,
      built_at:
        typeof parsed.built_at === "string" && parsed.built_at.length > 0
          ? parsed.built_at
          : UNKNOWN_BUILD_INFO.built_at
    };
  } catch {
    return UNKNOWN_BUILD_INFO;
  }
}
