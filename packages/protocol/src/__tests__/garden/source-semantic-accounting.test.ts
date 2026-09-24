import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { buildSourceReferenceCatalog } from "../../evidence/source-reference.js";
import { accountSourceSemanticDraft, assertSourceSemanticAccounting } from "../../garden/source-semantic-accounting.js";
import { SourceSemanticDraftSchema } from "../../garden/source-semantic-draft.js";
import { normalizeSourceSemantics } from "../../garden/normalize-source-semantics.js";
import { SourceSemanticResourceLedger } from "../../garden/source-semantic-resources.js";
import { UNKNOWN_UTTERANCE_ATTRIBUTION } from "../../conversation/utterance-attribution.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const catalog = buildSourceReferenceCatalog(sha("Alice runs. It rains."), [
  { assertion_id: 1, text: "Alice runs." }, { assertion_id: 2, text: "It rains." }
], sha);
const draft = () => SourceSemanticDraftSchema.parse({
  contract: "source-interpretation-v4",
  mentions: [{ id: "mRun", assertion_id: 1, source_ref: { first: "a1s2", last: "a1s2" } },
    { id: "mAlice", assertion_id: 1, source_ref: { first: "a1s0", last: "a1s0" } }],
  referents: [{ id: "rAlice", referent_kind: "grouped", mentions: ["mAlice"] }],
  frames: [{ id: "fRun", assertion_ids: [1, 2], context_owner: { kind: "source_act", source_act: "assertion" },
    predicate_support: { kind: "explicit", reading: "run", mentions: ["mRun"] }, additional_support: [],
    slots: [{ id: "agent", role_reading: "runner", support: [{ kind: "lexical", mentions: ["mAlice"] }] }],
    bindings: [] }], operators: [], gaps: []
});

it("retains omitted assertions, orphan referents and unbound slots as distinct gaps", () => {
  const result = accountSourceSemanticDraft(draft(), catalog);
  expect(result.gaps).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "uninterpreted_clause", affected_ids: ["rAlice"] }),
    expect.objectContaining({ kind: "uninterpreted_clause", affected_ids: ["hostAssertion2"] }),
    expect.objectContaining({ kind: "missing_binding", affected_ids: ["fRun"] })
  ]));
  expect(result.mentions.at(-1)).toEqual({ id: "hostAssertion2", assertion_id: 2,
    source_ref: { first: "a2s0", last: "a2s3" } });
  expect(result.frames[0]!.bindings).toEqual([]);
  expect(accountSourceSemanticDraft(result, catalog)).toEqual(result);
  expect(() => assertSourceSemanticAccounting(draft(), catalog)).toThrow(/accounting gaps/u);
  expect(() => assertSourceSemanticAccounting(result, catalog)).not.toThrow();
});

it("uses an existing located gap without inventing a relation or another assertion mention", () => {
  const value = draft();
  const withGap = SourceSemanticDraftSchema.parse({ ...value,
    mentions: [...value.mentions, { id: "mRain", assertion_id: 2, source_ref: { first: "a2s0", last: "a2s3" } }],
    gaps: [{ kind: "uninterpreted_clause", affected_ids: ["mRain"], support: [{ kind: "lexical", mentions: ["mRain"] }] }] });
  const result = accountSourceSemanticDraft(withGap, catalog);
  expect(result.mentions).toEqual(withGap.mentions);
  expect(result.gaps.filter((gap) => gap.affected_ids.includes("mRain"))).toHaveLength(1);
});

it("keeps embedded content nonasserted when its parent has no content binding", () => {
  const value = draft();
  const embedded = SourceSemanticDraftSchema.parse({ ...value, frames: [value.frames[0], {
    ...value.frames[0], id: "fWalk", slots: [],
    context_owner: { kind: "embedding", parent_frame: "fRun", content_argument: "fWalk" }
  }] });
  const result = normalizeSourceSemantics({ draft: embedded, catalog, sha256: sha,
    source: { source_id: "source", source_version: "1", content_digest: `sha256:${sha("source")}`,
      attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION },
    producer_id: "producer", producer_version: "1", contract_version: "source-interpretation-v4" });
  expect(result.status).toBe("normalized");
  if (result.status !== "normalized") throw new Error("expected normalized graph");
  expect(result.interpretation.asserted_at_scope).toEqual(["fRun"]);
  expect(result.interpretation.gaps).toContainEqual(expect.objectContaining({ kind: "missing_binding" }));
  expect(result.interpretation.frames[0]!.bindings).toEqual([]);
});

it("does not claim that an evidence-connected assertion has complete language fidelity", () => {
  const value = draft();
  const smallCatalog = buildSourceReferenceCatalog(sha("Alice runs quickly."), [{ assertion_id: 1, text: "Alice runs quickly." }], sha);
  const bound = SourceSemanticDraftSchema.parse({ ...value,
    frames: [{ ...value.frames[0], assertion_ids: [1], bindings: [{ slot_id: "agent", target: { kind: "node", id: "rAlice" }, support: [] }] }] });
  const result = accountSourceSemanticDraft(bound, smallCatalog);
  expect(result.gaps).toEqual([]);
  expect(result).not.toHaveProperty("semantic_complete");
  expect(result.frames).toEqual(bound.frames); // No adverb relation can be inferred mechanically.
});

const normalize = (value: unknown, sourceCatalog = catalog) => normalizeSourceSemantics({
  draft: value, catalog: sourceCatalog, sha256: sha,
  source: { source_id: "source", source_version: "1", content_digest: `sha256:${sha("source")}`,
    attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION },
  producer_id: "producer", producer_version: "1", contract_version: "source-interpretation-v4"
});

function manyMentions(count: number) {
  const value = draft();
  return { ...value, referents: [],
    mentions: Array.from({ length: count }, (_, i) => ({ ...value.mentions[0], id: i === 0 ? "mRun" : `m${i}` })),
    frames: [{ ...value.frames[0], assertion_ids: [1], slots: [] }]
  };
}

it.each([256, 257])("classifies host gap expansion at %i gaps without blaming valid producer input", (count) => {
  const value = SourceSemanticDraftSchema.parse(manyMentions(count + 1));
  const oneAssertion = buildSourceReferenceCatalog(sha("Alice runs."), [{ assertion_id: 1, text: "Alice runs." }], sha);
  const result = normalize(value, oneAssertion);
  expect(result.status).toBe(count === 256 ? "normalized" : "resource_exhausted");
  if (result.status === "normalized") expect(result.interpretation.gaps).toHaveLength(256);
});

it.each([511, 512])("classifies a host assertion mention added to %i producer mentions", (count) => {
  const value = manyMentions(count);
  const groups = Array.from({ length: Math.ceil(count / 64) }, (_, i) => value.mentions.slice(i * 64, (i + 1) * 64));
  const located = SourceSemanticDraftSchema.parse({ ...value, gaps: groups.map((rows) => ({
    kind: "uninterpreted_clause", affected_ids: rows.map((row) => row.id),
    support: [{ kind: "lexical", mentions: [rows[0]!.id] }]
  })) });
  const result = normalize(located);
  expect(result.status).toBe(count === 511 ? "normalized" : "resource_exhausted");
  if (result.status === "normalized") expect(result.interpretation.mentions).toHaveLength(512);
});

it("charges index preparation before traversing or copying source accounting graphs", () => {
  const meter = new SourceSemanticResourceLedger({ work_units: 1, memory_bytes: 1000000 });
  expect(() => accountSourceSemanticDraft(draft(), catalog, meter)).toThrow(/source accounting indexes budget exhausted/u);
  expect(meter.spentWork).toBe(1);
});
