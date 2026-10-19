import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";

const checker = fileURLToPath(new URL("./check-content-contracts.mjs", import.meta.url));
const counters = ["offline_fallbacks", "live_extraction_failures", "cached_extraction_failures"];

test("latest-passing requires explicitly measured zero seed failure counters", () => {
  const root = mkdtempSync(path.join(tmpdir(), "alaya-content-contracts-"));
  try {
    const bench = path.join(root, "public");
    const archive = path.join(bench, "run");
    mkdirSync(archive, { recursive: true });
    writeFileSync(path.join(bench, "latest-passing.json"), JSON.stringify({ slug: "run", kpi_path: "run/kpi.json" }));
    const check = (extraction) => {
      writeFileSync(path.join(archive, "kpi.json"), JSON.stringify({
        sample_size: 500, evaluated_count: 500,
        kpi: { seed_extraction_path: extraction, recall_token_economy: {} }
      }));
      return spawnSync(process.execPath, [checker, "--history-root", root], { encoding: "utf8" });
    };
    const complete = { path: "official_api_compile", ...Object.fromEntries(counters.map(field => [field, 0])) };
    const valid = check(complete);
    assert.equal(valid.status, 0, valid.stderr);
    for (const field of counters) {
      for (const value of [undefined, null, "0", -1, 0.5, 1]) {
        const result = check({ ...complete, [field]: value });
        assert.notEqual(result.status, 0, `${field}=${value}`);
        assert.match(result.stderr, new RegExp(`requires ${field}=0`));
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("latest-passing rejects Oracle and M archives with no applicable release gate", () => {
  const root = mkdtempSync(path.join(tmpdir(), "alaya-content-contracts-"));
  try {
    const bench = path.join(root, "public");
    const archive = path.join(bench, "run");
    mkdirSync(archive, { recursive: true });
    writeFileSync(path.join(bench, "latest-passing.json"), JSON.stringify({ slug: "run", kpi_path: "run/kpi.json" }));
    const complete = {
      embedding_provider: "none",
      sample_size: 500,
      evaluated_count: 500,
      kpi: {
        r_at_5: 0.95,
        seed_extraction_path: {
          path: "official_api_compile",
          ...Object.fromEntries(counters.map(field => [field, 0]))
        },
        recall_token_economy: {}
      }
    };
    const check = (split) => {
      writeFileSync(path.join(archive, "kpi.json"), JSON.stringify({ ...complete, split }));
      return spawnSync(process.execPath, [checker, "--history-root", root], { encoding: "utf8" });
    };
    const longMemEvalS = check("longmemeval-s");
    assert.equal(longMemEvalS.status, 0, longMemEvalS.stderr);
    for (const split of ["longmemeval-oracle", "longmemeval-m"]) {
      const result = check(split);
      assert.notEqual(result.status, 0, split);
      assert.match(
        result.stderr,
        new RegExp(`${split} cannot own the shared latest-passing pointer`)
      );
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
