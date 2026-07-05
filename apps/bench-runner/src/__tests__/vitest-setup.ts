import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Unit tests use ephemeral temp cache roots with mock extractors; they are not
// cache-only bench runs and should not require a committed extraction manifest.
process.env.ALAYA_BENCH_REQUIRE_EXTRACTION_CACHE_MANIFEST = "0";
// Keep vitest runs off the operator's local LongMemEval extraction cache so
// preflight drift checks do not bind tests to a particular model/manifest.
process.env.ALAYA_BENCH_EXTRACTION_CACHE_ROOT = mkdtempSync(
  join(tmpdir(), "alaya-bench-vitest-cache-")
);
