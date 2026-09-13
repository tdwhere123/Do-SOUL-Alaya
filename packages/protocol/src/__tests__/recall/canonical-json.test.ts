import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../recall/selection/capture/canonical-json.js";
import { sourceTextDigest } from "../../relations/relation-assertion.js";

const MIXED_KEYS = { a: 1, B: 2, "": 0 } as const;
const MIXED_KEYS_CANONICAL = '{"":0,"B":2,"a":1}';

describe("canonicalJson", () => {
  it("sorts object keys by UTF-16 code units and quotes keys", () => {
    expect(canonicalJson(MIXED_KEYS)).toBe(MIXED_KEYS_CANONICAL);
    expect(canonicalJson({ B: 2, a: 1, "": 0 })).toBe(MIXED_KEYS_CANONICAL);
  });

  it("is independent of process locale", () => {
    const distModule = fileURLToPath(
      new URL("../../../dist/recall/selection/capture/canonical-json.js", import.meta.url)
    );
    expect(fs.existsSync(distModule), "protocol dist must be built before locale identity check")
      .toBe(true);
    const moduleUrl = pathToFileURL(distModule).href;
    const script = `import { canonicalJson } from ${JSON.stringify(moduleUrl)};
process.stdout.write(canonicalJson({ a: 1, B: 2, "": 0 }));`;
    const fromC = canonicalizeInLocale("C", script);
    const fromUs = canonicalizeInLocale("en_US.UTF-8", script);
    expect(fromC).toBe(MIXED_KEYS_CANONICAL);
    expect(fromUs).toBe(MIXED_KEYS_CANONICAL);
  });
});

describe("sourceTextDigest", () => {
  it("prefixes SHA-256 of the source text and preserves null", () => {
    expect(sourceTextDigest(null, sha256)).toBeNull();
    expect(sourceTextDigest("hello", sha256)).toBe(`sha256:${sha256("hello")}`);
  });
});

function canonicalizeInLocale(locale: string, script: string): string {
  return execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: locale, LANG: locale, LC_COLLATE: locale }
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
