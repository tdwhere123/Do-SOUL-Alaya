import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  emitEnrichmentPreparation
} from "../../../../runs/extraction/enrichment-acceptance/emit-preparation.js";

const REGRESSION_REQUIRED = new Set([2, 4, 8, 9, 10, 12, 13, 14, 16]);
const REGRESSION_UNRESOLVED = new Set([5, 15]);
const TEXT = "I moved to Berlin.";
const TURN = {
  turnContent: TEXT,
  turnMessages: [{ message_id: "message-1", role: "user" as const, content: TEXT }]
};

describe("enrichment preparation emit", () => {
  let root: string | undefined;
  const previousFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = previousFetch;
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  });

  it("writes source-map, preflight, and preparation-report JSON on miniature turns without fetching", async () => {
    root = mkdtempSync(join(tmpdir(), "enrichment-emit-"));
    writeMiniaturePopulation(root);
    let fetches = 0;
    globalThis.fetch = async () => {
      fetches += 1;
      throw new Error("test fetch must not run");
    };
    const outputDir = join(root, "out");
    const result = await emitEnrichmentPreparation({
      regressionPath: join(root, "regression-source-review.json"),
      canonicalPath: join(root, "canonical-source-review.json"),
      outputDir,
      cacheRoot: join(root, "cache"),
      turns: [TURN],
      datasetRevision: "synthetic-revision"
    });
    expect(fetches).toBe(0);
    expect(result.attempted_fetches).toBe(0);
    expect(result.provider_calls).toBe(0);
    expect(result.query_calls).toBe(0);
    expect(result.candidate).toBe("HEAD");
    expect(result.semantic_fill.status).toBe("not_run");
    expect(result.semantic_fill.reason).toMatch(/substrate manifest/u);
    expect(result.source_fidelity.denominator).toBe(38);
    expect(existsSync(result.sourceMapPath)).toBe(true);
    expect(existsSync(result.preflightPath)).toBe(true);
    expect(existsSync(result.reportPath)).toBe(true);
    const sourceMap = JSON.parse(readFileSync(result.sourceMapPath, "utf8")) as {
      attempted_fetches: number;
      bindings: unknown[];
      identity_note: string;
    };
    const preflight = JSON.parse(readFileSync(result.preflightPath, "utf8")) as {
      dispatch_authorized: boolean;
      native_fill_readiness: string;
      preparation_stops: { human_unreviewed_does_not_block_first_window_proposal: boolean };
      semantic_fill: { status: string };
    };
    const report = JSON.parse(readFileSync(result.reportPath, "utf8")) as {
      source_fidelity: { human_verdicts: string; denominator: number };
      transport_parse: { attempted_fetches: number };
    };
    expect(sourceMap.attempted_fetches).toBe(0);
    expect(sourceMap.bindings).toHaveLength(38);
    expect(sourceMap.identity_note).toBe("Candidate HEAD tree HEAD");
    expect(preflight.dispatch_authorized).toBe(false);
    expect(preflight.native_fill_readiness).toBe("not_run");
    expect(preflight.semantic_fill.status).toBe("not_run");
    expect(preflight.preparation_stops.human_unreviewed_does_not_block_first_window_proposal).toBe(true);
    expect(report.source_fidelity.human_verdicts).toBe("unreviewed");
    expect(report.source_fidelity.denominator).toBe(38);
    expect(report.transport_parse.attempted_fetches).toBe(0);
  });

  it("refuses to overwrite existing preparation JSON", async () => {
    root = mkdtempSync(join(tmpdir(), "enrichment-emit-wx-"));
    writeMiniaturePopulation(root);
    const outputDir = join(root, "out");
    const input = {
      regressionPath: join(root, "regression-source-review.json"),
      canonicalPath: join(root, "canonical-source-review.json"),
      outputDir,
      cacheRoot: join(root, "cache"),
      turns: [TURN],
      datasetRevision: "synthetic-revision"
    };
    await emitEnrichmentPreparation(input);
    await expect(emitEnrichmentPreparation({
      ...input,
      cacheRoot: join(root, "cache-2")
    })).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("refuses to write over an incomplete preparation prefix", async () => {
    root = mkdtempSync(join(tmpdir(), "enrichment-emit-prefix-"));
    writeMiniaturePopulation(root);
    const outputDir = join(root, "out");
    mkdirSync(outputDir);
    writeFileSync(join(outputDir, "source-map.json"), "{}\n");
    await expect(emitEnrichmentPreparation({
      regressionPath: join(root, "regression-source-review.json"),
      canonicalPath: join(root, "canonical-source-review.json"),
      outputDir,
      cacheRoot: join(root, "cache"),
      turns: [TURN],
      datasetRevision: "synthetic-revision"
    })).rejects.toThrow(/incomplete and must not be overwritten/u);
    expect(existsSync(join(outputDir, "preflight.json"))).toBe(false);
    expect(existsSync(join(outputDir, "preparation-report.json"))).toBe(false);
  });

  it("refuses to emit when annotation paths are missing", async () => {
    root = mkdtempSync(join(tmpdir(), "enrichment-emit-missing-"));
    await expect(emitEnrichmentPreparation({
      regressionPath: join(root, "regression-source-review.json"),
      canonicalPath: join(root, "canonical-source-review.json"),
      outputDir: join(root, "out"),
      cacheRoot: join(root, "cache"),
      turns: [TURN],
      datasetRevision: "synthetic-revision"
    })).rejects.toThrow(/regressionPath is required and missing/u);
  });
});

function writeMiniaturePopulation(directory: string): void {
  const dual = new Set([1, 8, 10, 12, 14, 16]);
  const requiredCanonical = new Set(["1:1", "5:1", "10:2", "11:1", "12:2", "16:2"]);
  const regression = {
    assertions: Array.from({ length: 16 }, (_, index) => {
      const assertionId = index + 1;
      const classification = REGRESSION_REQUIRED.has(assertionId)
        ? "in_scope_durable_proposition"
        : REGRESSION_UNRESOLVED.has(assertionId)
          ? "unsupported_unresolved_interpretation"
          : "legitimate_abstention_candidate";
      return {
        key: "aa".repeat(32),
        assertion_id: assertionId,
        exact_text: `User: regression fact ${assertionId}.`,
        source_message_id: "msg-1",
        source_locator: { assertion_id: assertionId },
        source_occurrence_identity: "bb".repeat(32),
        original_source: { exact_text: `regression fact ${assertionId}.` },
        classification,
        obligations: ["keep slogan"],
        prohibited_inferences: ["invent ownership"]
      };
    })
  };
  const requests = Array.from({ length: 16 }, (_, index) => {
    const canonicalIndex = index + 1;
    return {
      canonical_index: canonicalIndex,
      key: canonicalIndex.toString(16).padStart(64, "0"),
      assertion_reviews: Array.from({ length: dual.has(canonicalIndex) ? 2 : 1 }, (__, offset) => {
        const assertionId = offset + 1;
        const classification = requiredCanonical.has(`${canonicalIndex}:${assertionId}`)
          ? "in_scope_durable_proposition"
          : "legitimate_abstention_candidate";
        return {
          key: canonicalIndex.toString(16).padStart(64, "0"),
          assertion_id: assertionId,
          exact_text: `canonical ${canonicalIndex} ${assertionId}.`,
          source_message_ids: ["canonical-msg"],
          occurrence_bindings: [{ occurrenceIdentity: "cc".repeat(32) }],
          classification,
          coverage: ["retain roots"],
          forbidden: ["invent citizenship"]
        };
      })
    };
  });
  const canonical = {
    canonical_sample_keys: requests.map((request) => request.key),
    requests
  };
  writeFileSync(join(directory, "regression-source-review.json"), JSON.stringify(regression));
  writeFileSync(join(directory, "canonical-source-review.json"), JSON.stringify(canonical));
}
