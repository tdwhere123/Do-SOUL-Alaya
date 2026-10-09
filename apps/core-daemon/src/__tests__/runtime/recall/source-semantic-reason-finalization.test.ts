import { aliceUsesDraft } from "./source-semantic-library-binding-coverage.js";
import { buildSourceReferenceCatalog, normalizeSourceSemantics, UNKNOWN_UTTERANCE_ATTRIBUTION } from "@do-soul/alaya-protocol";
import { fieldContractSha256, projectSourceDisclosure } from "@do-soul/alaya-core";
import { expect, it } from "vitest";
import { finalizeSourceSemanticReason } from "../../../runtime/recall-read-worker/source-semantic-reason-finalization.js";

const disclosure = projectSourceDisclosure({
  material_kind: "interpretation",
  evaluated_as_of: "2026-09-23T00:00:00.000Z",
  source: { event_time: "2026-09-23T00:00:00.000Z", valid_from: "2026-09-23T00:00:00.000Z", valid_to: null },
  proof_use: "conditional_support"
});
const coverage = { discovery: "complete", source_interpretation: "open", query_semantics: "complete",
  semantic_correspondence: "open", conditional_computation: "complete", payload: "complete" } as const;
const work = { native_work: 1, native_bytes: 1, logical_memory_bytes: 1, rss_bytes: 1 };

it("truncates an oversized reason without demoting conditional proof use or world qualifiers", () => {
  const source = "Alice uses Pixel, a tool.";
  const catalog = buildSourceReferenceCatalog(fieldContractSha256(source), [{ assertion_id: 1, text: source }], fieldContractSha256);
  const draft = aliceUsesDraft(catalog, "Pixel");
  const normalized = normalizeSourceSemantics({
    draft: { ...draft, gaps: Array.from({ length: 4 }, () => ({ kind: "unsupported_meaning", affected_ids: [], support: [], description: "x".repeat(1000) })) },
    catalog,
    sha256: fieldContractSha256, source: { source_id: "source", source_version: "1", content_digest: `sha256:${fieldContractSha256(source)}`,
      attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION }, producer_id: "fixture", producer_version: "1", contract_version: "source-interpretation-v4"
  });
  if (normalized.status !== "normalized") throw new Error(`legal interpretation expected: ${JSON.stringify(normalized)}`);
  const fitted = finalizeSourceSemanticReason({
    kind: "reason",
    source_disclosure: disclosure,
    interpretation: normalized.interpretation,
    result: {
      contract: "source-interpretation-reasoning-v5", semantic_status: "unreviewed",
      conclusion_scope: "conditional_on_interpretation", world_claim: "unknown",
      outcome: { status: "unexercised" }, consumed_leaves: []
    },
    coverage, work
  }, 1024);
  expect(fitted.source_disclosure.proof_use).toEqual({ kind: "conditional_support", qualification: "not_world_claim" });
  expect(fitted.result.outcome).toEqual({ status: "truncated" });
  expect(fitted.result.semantic_status).toBe("unreviewed");
  expect(fitted.result.world_claim).toBe("unknown");
  expect(fitted.result.conclusion_scope).toBe("conditional_on_interpretation");
  expect(fitted.coverage.payload).toBe("truncated");
  expect(fitted).not.toHaveProperty("interpretation");
  expect(Buffer.byteLength(JSON.stringify(fitted), "utf8")).toBeLessThanOrEqual(1024);
});
