import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { HostTokenizer } from "../../../recall/decision/budget-aware-q/render.js";

export async function loadOfflineHostTokenizer(profile: HostTokenizer["profile"]): Promise<HostTokenizer> {
  const modulePath = process.env.ALAYA_HOST_TOKENIZER_MODULE;
  const manifestPath = process.env.ALAYA_HOST_TOKENIZER_MANIFEST;
  if (!modulePath || !manifestPath) throw new Error("mandatory host tokenizer needs ALAYA_HOST_TOKENIZER_MODULE and ALAYA_HOST_TOKENIZER_MANIFEST");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    package: string; version: string; files: { path: string; sha256: string }[];
  };
  if (manifest.package !== "js-tiktoken" || manifest.version !== "1.0.21") throw new Error("unexpected host tokenizer implementation");
  const moduleRecord = manifest.files.find((file) => file.path === modulePath);
  if (!moduleRecord) throw new Error("host tokenizer module is absent from admitted inventory");
  for (const file of manifest.files) {
    const digest = createHash("sha256").update(await readFile(file.path)).digest("hex");
    if (digest !== file.sha256) throw new Error(`host tokenizer asset changed: ${file.path}`);
  }
  const implementation = await import(/* @vite-ignore */ pathToFileURL(modulePath).href) as {
    getEncoding: (name: string) => {
      rankMap: Map<string, number>; textMap: Map<number, Uint8Array>;
      encode: (text: string, allowed: string[], disallowed: string[]) => number[];
    };
  };
  const encoder = implementation.getEncoding(profile);
  for (let byte = 0; byte < 256; byte += 1) {
    if (!encoder.rankMap.has(String(byte))) throw new Error("host tokenizer lacks byte-complete ordinary vocabulary");
  }
  for (const bytes of encoder.textMap.values()) {
    if (bytes.length === 0) throw new Error("host tokenizer has zero-byte ordinary token");
  }
  return Object.freeze({ profile, implementation: "js-tiktoken@1.0.21", assetSha256: moduleRecord.sha256,
    encodeOrdinary: (text: string) => encoder.encode(text, [], []) });
}
