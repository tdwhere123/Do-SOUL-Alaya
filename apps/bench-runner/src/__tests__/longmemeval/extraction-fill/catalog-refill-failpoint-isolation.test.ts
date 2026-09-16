import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertCatalogRefillTestFailpointUnreachable,
  CATALOG_REFILL_TEST_FAILPOINT_ENV,
  runExtractionFill
} from "../../../runs/extraction/extraction-fill.js";
import * as extractionFill from "../../../runs/extraction/extraction-fill.js";
import {
  installCatalogRefillResumeFailpoint,
  runExtractionFillForTests
} from "../test-support/catalog-refill-failpoint.js";

const repoSrc = dirname(fileURLToPath(import.meta.url));

describe("catalog refill failpoint isolation", () => {
  afterEach(() => {
    installCatalogRefillResumeFailpoint(undefined);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("keeps the production write path free of the module-level failpoint hook", () => {
    const fill = readFileSync(
      join(repoSrc, "../../../runs/extraction/extraction-fill.ts"),
      "utf8"
    );
    const runtime = readFileSync(
      join(repoSrc, "../../../runs/extraction/fill/catalog-refill/runtime.ts"),
      "utf8"
    );
    expect(fill).not.toMatch(/resume-failpoint/);
    expect(fill).not.toMatch(/installedFailpoint/);
    expect(fill).toContain("assertCatalogRefillTestFailpointUnreachable");
    expect(fill).toMatch(/runExtractionFillBody\(options,\s*undefined\)/u);
    expect(runtime).not.toMatch(/resume-failpoint/);
    expect(runtime).not.toMatch(/installedFailpoint/);
    expect(runtime).toMatch(/durableFailpoint\?\./u);
  });

  it("lets tests inject a failpoint into the catalog-refill write path", async () => {
    const seen: string[] = [];
    installCatalogRefillResumeFailpoint((boundary) => {
      seen.push(boundary);
    });
    vi.spyOn(extractionFill, "runExtractionFillWithDurableFailpoint")
      .mockImplementation(async (_options, durableFailpoint) => {
        durableFailpoint?.("failure-manifest-published");
        return {} as never;
      });
    await runExtractionFillForTests({} as never);
    expect(seen).toEqual(["failure-manifest-published"]);
  });

  it("asserts the production entry cannot see the test failpoint env", () => {
    expect(() => assertCatalogRefillTestFailpointUnreachable({})).not.toThrow();
    expect(() => assertCatalogRefillTestFailpointUnreachable({
      [CATALOG_REFILL_TEST_FAILPOINT_ENV]: "failure-manifest-published"
    })).toThrow(/unreachable from the production entry/u);
  });

  it("rejects production fill when the failpoint env is set", async () => {
    vi.stubEnv(CATALOG_REFILL_TEST_FAILPOINT_ENV, "failure-manifest-published");
    await expect(runExtractionFill({
      variant: "longmemeval_s"
    } as never)).rejects.toThrow(/unreachable from the production entry/u);
  });
});
