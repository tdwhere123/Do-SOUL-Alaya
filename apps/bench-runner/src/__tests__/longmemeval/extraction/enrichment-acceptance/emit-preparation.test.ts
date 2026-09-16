import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planOfficialApiSemanticWorkset } from "@do-soul/alaya-soul";
import {
  emitEnrichmentPreparation,
  toBindingRequests
} from "../../../../runs/extraction/enrichment-acceptance/emit-preparation.js";
import { bindFrozenAssertionToCurrentSource } from "../../../../runs/extraction/enrichment-acceptance/source-binding.js";

const REGRESSION_REQUIRED = new Set([2, 4, 8, 9, 10, 12, 13, 14, 16]);
const REGRESSION_UNRESOLVED = new Set([5, 15]);
const TEXT = "I moved to Berlin.";
const PINNED_CANDIDATE = "aa".repeat(20);
const PINNED_TREE = "bb".repeat(20);
const PINNED = { candidate: PINNED_CANDIDATE, codeTree: PINNED_TREE } as const;
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
      datasetRevision: "synthetic-revision",
      ...PINNED
    });
    expect(fetches).toBe(0);
    expect(result.attempted_fetches).toBe(0);
    expect(result.provider_calls).toBe(0);
    expect(result.query_calls).toBe(0);
    expect(result.candidate).toBe(PINNED_CANDIDATE);
    expect(result.code_tree).toBe(PINNED_TREE);
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
    expect(sourceMap.identity_note).toBe(`Candidate ${PINNED_CANDIDATE} tree ${PINNED_TREE}`);
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
      datasetRevision: "synthetic-revision",
      ...PINNED
    };
    await emitEnrichmentPreparation(input);
    await expect(emitEnrichmentPreparation({
      ...input,
      cacheRoot: join(root, "cache-2")
    })).rejects.toMatchObject({ name: "AlayaError", code: "CONFLICT" });
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
      datasetRevision: "synthetic-revision",
      ...PINNED
    })).rejects.toMatchObject({ name: "AlayaError", code: "CONFLICT" });
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
      datasetRevision: "synthetic-revision",
      ...PINNED
    })).rejects.toThrow(/regressionPath is required and missing/u);
  });

  it("refuses the moving ref HEAD as a candidate identity", async () => {
    root = mkdtempSync(join(tmpdir(), "enrichment-emit-head-"));
    writeMiniaturePopulation(root);
    await expect(emitEnrichmentPreparation({
      regressionPath: join(root, "regression-source-review.json"),
      canonicalPath: join(root, "canonical-source-review.json"),
      outputDir: join(root, "out"),
      cacheRoot: join(root, "cache"),
      turns: [TURN],
      datasetRevision: "synthetic-revision",
      candidate: "HEAD",
      codeTree: "HEAD"
    })).rejects.toMatchObject({ name: "AlayaError", code: "VALIDATION" });
  });

  it("packs occurrence identity by corpus and assertion id so a foreign message is not substituted", () => {
    const originalMessages = [{
      role: "user" as const,
      content: TEXT,
      message_id: "original-message"
    }];
    const foreignMessages = [{
      role: "user" as const,
      content: TEXT,
      message_id: "foreign-message"
    }];
    const original = planOfficialApiSemanticWorkset(TEXT, originalMessages, "synthetic-revision").units[0]!;
    const foreign = planOfficialApiSemanticWorkset(TEXT, foreignMessages, "synthetic-revision").units[0]!;
    expect(original.assertionId).toBe(foreign.assertionId);
    expect(original.binding.sourceCorpusIdentity).toBe(foreign.binding.sourceCorpusIdentity);
    expect(original.binding.occurrenceIdentity).not.toBe(foreign.binding.occurrenceIdentity);
    const requests = toBindingRequests({
      requests: [{
        key: "original-request",
        source_corpus_identity: original.binding.sourceCorpusIdentity,
        assertion_ids: [original.assertionId],
        assertion_texts: [original.text],
        occurrence_provenance: [{ assertion_id: original.assertionId,
          occurrenceIdentity: original.binding.occurrenceIdentity, source_message_id: "original-message" }],
        user_prompt: TEXT,
        unit_keys: [original.semanticKey],
        message_ids: ["original-message"]
      }]
    });
    expect(requests[0]?.source_assertions[0]?.occurrenceIdentity)
      .toBe(original.binding.occurrenceIdentity);
    expect(requests[0]?.source_assertions[0]?.occurrenceIdentity)
      .not.toBe(foreign.binding.occurrenceIdentity);
    const binding = bindFrozenAssertionToCurrentSource({
      population: "regression",
      annotation_pointer: {
        file: "regression-source-review.json",
        assertion_id: 1,
        request_key: "aa".repeat(32),
        canonical_index: null
      },
      original_ordinal: 1,
      exact_text: original.text,
      original_source: { exact_text: original.text },
      occurrence: {
        source_message_ids: ["original-message"],
        source_locator: original.binding.locator,
        source_occurrence_identity: original.binding.occurrenceIdentity ?? null,
        occurrence_bindings: [{
          ...original.binding,
          source_message_id: "original-message"
        }]
      },
      classification: "optional",
      required_group_id: null,
      first_stage_subset: true,
      obligations: [],
      forbidden: [],
      duplicate_of: null,
      participants: null,
      source_role: null,
      modality: null,
      conditions: null,
      scope: null,
      time: null,
      event_policy: null
    }, {
      catalogUnits: [foreign],
      requests
    });
    expect(binding.status).toBe("unbound");
    expect(binding.current).toEqual([]);
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
