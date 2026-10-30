import { afterAll, afterEach, expect, it, vi } from "vitest";
const boundary = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExtractionFill, type ExtractionFillOptions } from "../../../runs/extraction/extraction-fill.js";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION } from "../../../runs/extraction/request-artifact.js";

const directories: string[] = [];
afterEach(() => { for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true }); });
afterAll(() => { boundary.restore(); expect(boundary.violations).toEqual([]); });

it.each([
  { variant: "longmemeval_s", sourcePacking: "complete-source", openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION },
  { variant: "native_source_snapshot", sourcePacking: "complete-source", openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION },
  { variant: "longmemeval_s", sourcePacking: "reference-eight" },
  { variant: "longmemeval_s", sourcePacking: "singleton" }
] satisfies Partial<ExtractionFillOptions>[])(
  "refuses new $variant $sourcePacking work before transport, dataset or retained-cache mutation", async generation => {
    const cacheRoot = mkdtempSync(join(tmpdir(), "retired-passive-fill-")); directories.push(cacheRoot);
    const path = join(cacheRoot, "retained.json"), bytes = Buffer.from('{"retained":"opaque historical bytes"}\n');
    writeFileSync(path, bytes);
    const extractorFactory = vi.fn(() => { throw new Error("retired producer was constructed"); });
    await expect(runExtractionFill({ ...generation, cacheRoot, dataDir: join(cacheRoot, "absent-dataset"),
      extractorFactory })).rejects.toThrow("retired passive generation");
    expect(extractorFactory).not.toHaveBeenCalled();
    expect(readdirSync(cacheRoot)).toEqual(["retained.json"]);
    expect(readFileSync(path)).toEqual(bytes);
  }
);
