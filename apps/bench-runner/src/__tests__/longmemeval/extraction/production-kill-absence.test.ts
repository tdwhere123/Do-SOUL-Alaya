import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as datasetFetch from "../../../datasets/longmemeval/ingestion/fetch.js";
import { createTestLongMemEvalDatasetAuthority } from
  "../ingestion/test-dataset-authority.js";

const productionRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../runs"
);

function productionSources(root: string): readonly string[] {
  return readdirSync(root).flatMap((entry) => {
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) return [...productionSources(path)];
    return path.endsWith(".ts") ? [path] : [];
  });
}

describe("production crash-injection absence", () => {
  it("keeps process.kill(process.pid) out of production sources", () => {
    const hits = productionSources(productionRoot).filter((path) =>
      readFileSync(path, "utf8").includes("process.kill(process.pid")
    );
    expect(hits).toEqual([]);
  });

  it("refuses a forged test dataset authority token", () => {
    expect("createTestLongMemEvalDatasetAuthority" in datasetFetch).toBe(false);
    expect("LONGMEMEVAL_DATASET_TEST_AUTHORITY_KIND" in datasetFetch).toBe(false);
    expect(() => datasetFetch.mintLongMemEvalDatasetAuthorityFromTestToken(
      { kind: "longmemeval-dataset-test-authority" },
      { datasetSha256: "aa".repeat(32), assignments: [] }
    )).toThrow(/test-only LongMemEval authority seam is unavailable/u);
    expect(createTestLongMemEvalDatasetAuthority({
      datasetSha256: "aa".repeat(32),
      assignments: []
    })).toBeDefined();
  });
});
