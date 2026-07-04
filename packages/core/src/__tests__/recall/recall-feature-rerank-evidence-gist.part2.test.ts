import { describe, expect, it } from "vitest";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import { computeRerankFeatures } from "../../recall/rerank/recall-feature-rerank.js";

describe("recall feature rerank — evidence-gist field (B2)", () => {
it("uses the highest-rank ref's gist semantics — empty gist on the top ref does not block scoring", () => {
    // The gist path scores whatever non-empty gist the caller selected. If
    // the highest-rank ref's gist is empty the caller-side fallback (see
    // collectEvidenceGistsByMemoryId) picks the next non-empty ref; this
    // test pins the scorer's contract end of that handoff — given a
    // non-empty gist string (i.e. the fallback already fired), the scorer
    // produces a meaningful signal, and given an empty string it collapses
    // to the content-only baseline.
    const query = compileRecallQueryProbes("backup retention schedule");
    const opaqueContent = "Operator chose the conservative policy in the planning thread.";
    const fallbackGist =
      "Operator explicitly mentioned the backup retention schedule should stay weekly.";

    const withFallback = computeRerankFeatures(query, {
      content: opaqueContent,
      hasEvidenceLexicalHit: true,
      evidenceGist: fallbackGist
    });
    const withEmpty = computeRerankFeatures(query, {
      content: opaqueContent,
      hasEvidenceLexicalHit: true,
      evidenceGist: ""
    });

    // With a usable fallback gist the scorer surfaces gist-side features.
    expect(withFallback.exactPhrase).toBe(1);
    expect(withFallback.score).toBeGreaterThan(0);
    // With an empty gist the scorer must collapse to the content-only
    // baseline (no gist credit, no exception).
    expect(withEmpty.score).toBe(0);
  });
});
