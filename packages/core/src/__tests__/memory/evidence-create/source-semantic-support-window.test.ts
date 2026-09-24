import { describe, expect, it } from "vitest";
import {
  buildSourceReferenceCatalog, normalizeSourceSemantics, SourceSemanticResourceLedger,
  UNKNOWN_UTTERANCE_ATTRIBUTION,
  type SourceSemanticGraph, type SourceSemanticInterpretation
} from "@do-soul/alaya-protocol";
import { bindSourceSemanticLocations, verifySourceSemanticLocations } from "../../../memory/evidence-create/source-semantic-location.js";
import { sourceSemanticSupportWindow } from "../../../memory/evidence-create/source-semantic-support-window.js";
import { sourceSpanFromCodeUnitOffsets } from "../../../memory/evidence-create/source-span-views.js";
import { fieldContractSha256 as sha } from "../../../shared/field-hash.js";

const ledger = () => new SourceSemanticResourceLedger({ work_units: 1_000_000, memory_bytes: 20_000_000 });

function fixture(units: readonly string[], transform = (graph: SourceSemanticGraph) => graph, prefix = "", suffix = "") {
  const source = prefix + units.join("\n") + suffix;
  const catalog = buildSourceReferenceCatalog(sha(source), units.map((text, index) => ({ assertion_id: index + 1, text })), sha);
  const graph: SourceSemanticGraph = {
    mentions: catalog.assertions.map((row) => ({ id: `m${row.assertion_id}`, assertion_id: row.assertion_id,
      source_ref: { first: row.segments[0]!.id, last: row.segments.at(-1)!.id } })),
    referents: [], operators: [], gaps: [],
    frames: units.map((_, index) => ({ id: `f${index + 1}`, assertion_ids: [index + 1],
      context_owner: { kind: "source_act", source_act: "assertion" }, additional_support: [],
      predicate_support: { kind: "explicit", reading: "fixture occurrence", mentions: [`m${index + 1}`] },
      slots: [], bindings: [] }))
  };
  const normalized = normalizeSourceSemantics({ draft: { contract: "source-interpretation-v4", ...transform(graph) },
    catalog, sha256: sha, source: { source_id: "source", source_version: "1", content_digest: `sha256:${sha(source)}`,
      attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION },
    producer_id: "authored-window-fixture", producer_version: "1", contract_version: "source-interpretation-v4" });
  expect(normalized.status, JSON.stringify(normalized)).toBe("normalized");
  if (normalized.status !== "normalized") throw new Error(JSON.stringify(normalized));
  let offset = prefix.length;
  const locations = units.map((text, index) => {
    const span = sourceSpanFromCodeUnitOffsets(source, { start_offset: offset, end_offset: offset + text.length, purpose: "native_structure" });
    offset += text.length + 1;
    return { assertion_id: index + 1, source_utf8_span: [span.start_offset, span.end_offset] as const };
  });
  const interpretation = bindSourceSemanticLocations({ source, interpretation: normalized.interpretation, catalog, locations, sha256: sha });
  expect(verifySourceSemanticLocations(source, interpretation, sha)).toEqual(interpretation);
  return { source, interpretation };
}

function window(value: { source: string; interpretation: SourceSemanticInterpretation }, dependency_ids: readonly string[], max_bytes = 4096,
  meter = ledger()) {
  return sourceSemanticSupportWindow({ ...value, dependency_ids, max_bytes, meter });
}

describe("source support windows relative to admitted interpretation dependencies", () => {
  it("uses verified late occurrence coordinates, retaining inline reporter, possibility and dates", () => {
    const sentence = "On 2026-04-09, Omar reported that Talia might approve grant G-8 on 2026-04-10.";
    const prefix = `Quoted earlier: ${sentence}\n${"Unrelated notes. ".repeat(300)}\n`;
    const value = fixture([sentence], undefined, prefix, "\nUnrelated tail.");
    expect(window(value, ["f1"])).toEqual({ status: "available", kind: "support_window", text: sentence,
      start_offset: Buffer.byteLength(prefix), end_offset: Buffer.byteLength(prefix + sentence), source_complete: false });
  });

  it.each(["lexical", "affected"] as const)("retains cross-sentence governing context and %s gap locations", (location) => {
    const units = ["Omar's hypothetical account follows.", "Talia approves grant G-8 tomorrow.",
      "This account does not establish actual approval.", "Unrelated entry."];
    const value = fixture(units, (graph) => ({ ...graph,
      frames: graph.frames.filter((row) => row.id !== "f1").map((row) => row.id === "f2"
        ? { ...row, context_owner: { kind: "operator", operator_handle: "possibility" } } : row),
      referents: [{ id: "reporter", referent_kind: "grouped", mentions: ["m1"] }],
      operators: [
        { id: "possibility", operator: "possible", content: "f2", assertion_ids: [1], additional_support: [],
          context_owner: { kind: "operator", operator_handle: "report" } },
        { id: "report", operator: "reported", reporter: "reporter", content: "possibility", assertion_ids: [1],
          additional_support: [{ kind: "lexical", mentions: ["m1"] }], context_owner: { kind: "source_act", source_act: "assertion" } }
      ], gaps: [location === "lexical"
        ? { kind: "unsupported_meaning", affected_ids: ["f2"], support: [{ kind: "lexical", mentions: ["m3"] }] }
        : { kind: "unsupported_meaning", affected_ids: ["f2", "m3"], support: [] }]
    }));
    expect(window(value, ["f2"])).toMatchObject({ status: "available", kind: "support_window", text: units.slice(0, 3).join("\n"), source_complete: false });
    expect(window(value, ["f4"])).toMatchObject({ status: "available", text: units[3] });
  });

  it("does not pretend to detect a qualifier omitted by the interpretation", () => {
    const value = fixture(["Talia approves grant G-8 tomorrow."], undefined,
      "Omar's hypothetical account follows.\n", "\nThis account does not establish actual approval.");
    expect(window(value, ["f1"])).toMatchObject({ status: "available", kind: "support_window",
      text: "Talia approves grant G-8 tomorrow.", source_complete: false });
  });

  it("includes finite rule, roster membership and closure from source origins, not synthetic derived coordinates", () => {
    const units = ["Every roster member presented.", "Aya is a roster member.", "Ben is a roster member.",
      "The roster contains exactly Aya and Ben."];
    const value = fixture(units, (graph) => ({ ...graph,
      frames: graph.frames.map((row) => row.id === "f1"
        ? { ...row, context_owner: { kind: "operator", operator_handle: "allMembers" },
          slots: [{ id: "presenter", role_reading: "presenter", support: [] }],
          bindings: [{ slot_id: "presenter", target: { kind: "bound_variable", quantifier: "allMembers", binder: "person" }, support: [] }] } : row),
      referents: [{ id: "aya", referent_kind: "grouped", mentions: ["m2"] }, { id: "ben", referent_kind: "grouped", mentions: ["m3"] }],
      operators: [{ id: "allMembers", operator: "forall", content: "f1", binder: "person", domain: "roster", restriction: null,
        assertion_ids: [1], additional_support: [], context_owner: { kind: "source_act", source_act: "assertion" } }],
      domains: [{ id: "roster", context: null, support: [{ kind: "lexical", mentions: ["m4"] }],
        members: [{ referent: "aya", evidence: "f2", restrictions: [] }, { referent: "ben", evidence: "f3", restrictions: [] }],
        exclusions: [], closure: { kind: "closed", evidence: "f4" } }]
    }));
    expect(window(value, ["f1", "f2"])).toMatchObject({ status: "available", text: units.join("\n"), source_complete: true });
    expect(window(value, ["@derived:aya"])).toEqual({ status: "unavailable", reason: "unknown_dependency" });
  });

  it("keeps a distant required qualifier atomic and counts UTF-8 bytes instead of characters", () => {
    const units = ["Omar reported: \"Talia might approve 🧭\".", "Intervening notes. ".repeat(20), "The report was hypothetical."];
    const value = fixture(units, (graph) => ({ ...graph, frames: graph.frames.map((row) => row.id === "f1"
      ? { ...row, additional_support: [{ kind: "lexical", mentions: ["m3"] }] } : row) }));
    const exact = Buffer.byteLength(units.join("\n"));
    expect(window(value, ["f1"], exact)).toMatchObject({ status: "available", text: value.source });
    expect(window(value, ["f1"], exact - 1)).toEqual({ status: "unavailable", reason: "display_budget" });
    expect(window(value, ["f1"], value.source.length)).toEqual({ status: "unavailable", reason: "display_budget" });
  });

  it("preserves an unlocated required identity and only falls back within the same source display cap", () => {
    const value = fixture(["They might approve."], (graph) => ({ ...graph,
      referents: [{ id: "unexpressedActor", referent_kind: "unexpressed", mentions: [] }],
      frames: graph.frames.map((row) => ({ ...row, slots: [{ id: "actor", role_reading: "actor", support: [] }],
        bindings: [{ slot_id: "actor", target: { kind: "node", id: "unexpressedActor" }, support: [] }] }))
    }));
    expect(window(value, ["f1"], Buffer.byteLength(value.source))).toMatchObject({ status: "available", kind: "whole_source",
      fallback_reason: "location_missing", text: value.source, source_complete: true });
    expect(window(value, ["f1"], Buffer.byteLength(value.source) - 1)).toEqual({ status: "unavailable", reason: "location_missing" });
  });

  it("does not silently discard a missing required assertion location or widen its fallback allowance", () => {
    const value = fixture(["Omar reported.", "Talia might approve."], (graph) => ({ ...graph,
      frames: graph.frames.map((row) => row.id === "f2" ? { ...row, additional_support: [{ kind: "dominating", via_id: "f1" }] } : row) }));
    const missing = { ...value, interpretation: { ...value.interpretation,
      source: { ...value.interpretation.source, assertion_locations: value.interpretation.source.assertion_locations?.slice(1) } } };
    expect(window(missing, ["f2"])).toMatchObject({ status: "available", kind: "whole_source", fallback_reason: "location_missing" });
    expect(window(missing, ["f2"], 20)).toEqual({ status: "unavailable", reason: "location_missing" });
  });

  it("charges traversal and actual UTF-8 extraction, preserving work and memory exhaustion as unavailable", () => {
    const value = fixture(["Talia might approve 🧭."]);
    const used = ledger();
    expect(window(value, ["f1"], 4096, used).status).toBe("available");
    expect(used.spentWork).toBeGreaterThan(value.source.length * 3);
    expect(used.spentBytes).toBeGreaterThan(Buffer.byteLength(value.source) * 2);
    for (const meter of [new SourceSemanticResourceLedger({ work_units: used.spentWork - 1, memory_bytes: 20_000_000 }),
      new SourceSemanticResourceLedger({ work_units: 1_000_000, memory_bytes: used.spentBytes - 1 })]) {
      expect(window(value, ["f1"], 4096, meter)).toEqual({ status: "unavailable", reason: "resource_budget" });
      expect(meter.spentWork).toBeGreaterThan(0);
    }
    const exact = new SourceSemanticResourceLedger({ work_units: used.spentWork, memory_bytes: used.spentBytes });
    expect(window(value, ["f1"], 4096, exact).status).toBe("available");
    expect(exact.remaining()).toEqual({ work_units: 0, memory_bytes: 0 });
    expect(window(value, [])).toEqual({ status: "unavailable", reason: "no_dependencies" });
  });
});
