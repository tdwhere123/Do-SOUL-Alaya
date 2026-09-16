import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertMaterializationTestFailpointUnreachable,
  MATERIALIZATION_TEST_FAILPOINT_ENV,
  materializeAuditedExtractionCacheTarget
} from "../../../runs/extraction/cache-audit/target-materializer.js";
import {
  installMaterializationDurableFailpoint,
  installedMaterializationDurableFailpoint
} from "../test-support/materialization-failpoint.js";

const repoSrc = dirname(fileURLToPath(import.meta.url));

describe("materialization failpoint isolation", () => {
  afterEach(() => {
    installMaterializationDurableFailpoint(undefined);
    vi.unstubAllEnvs();
  });

  it("keeps the production write path free of the module-level failpoint hook", () => {
    const transaction = readFileSync(
      join(repoSrc, "../../../runs/extraction/cache-audit/materialization/transaction.ts"),
      "utf8"
    );
    const materializer = readFileSync(
      join(repoSrc, "../../../runs/extraction/cache-audit/target-materializer.ts"),
      "utf8"
    );
    expect(transaction).not.toMatch(/transaction-failpoint/);
    expect(transaction).not.toMatch(/installedFailpoint/);
    expect(transaction).toMatch(/durableFailpoint\?\./u);
    expect(materializer).toContain("assertMaterializationTestFailpointUnreachable");
    expect(materializer).toMatch(/durableFailpoint:\s*undefined/u);
  });

  it("lets tests inject a failpoint without a production module hook", () => {
    const seen: string[] = [];
    installMaterializationDurableFailpoint((boundary) => {
      seen.push(boundary);
    });
    installedMaterializationDurableFailpoint()?.("journal-published");
    expect(seen).toEqual(["journal-published"]);
  });

  it("asserts the production entry cannot see the test failpoint env", () => {
    expect(() => assertMaterializationTestFailpointUnreachable({})).not.toThrow();
    expect(() => assertMaterializationTestFailpointUnreachable({
      [MATERIALIZATION_TEST_FAILPOINT_ENV]: "journal-published"
    })).toThrow(/unreachable from the production entry/u);
  });

  it("rejects production materialize before lease acquisition when the failpoint env is set", () => {
    vi.stubEnv(MATERIALIZATION_TEST_FAILPOINT_ENV, "journal-published");
    expect(() => materializeAuditedExtractionCacheTarget({
      sourceRoot: "missing-source",
      targetRoot: "missing-target",
      auditReceipt: {} as never,
      inventory: {} as never,
      targetSelection: {} as never,
      auditedSourceManifestRaw: "",
      now: () => "2026-01-01T00:00:00.000Z"
    })).toThrow(/unreachable from the production entry/u);
  });
});
