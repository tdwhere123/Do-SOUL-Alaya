import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadOfflineHostTokenizer } from "./host-tokenizer-test-support.js";
import { fieldContractSha256 } from "../../../shared/field-hash.js";
import { captureQuerySpec } from "../../../recall/decision/budget-aware-q/capture.js";
import { selectBudgetAwareQ } from "../../../recall/decision/budget-aware-q/select.js";
import { packDecision, withClaims } from "../../../recall/decision/budget-aware-q/claims.js";
import { frameEntry, type EvidenceUnit } from "../../../recall/decision/budget-aware-q/types.js";
import { coalesceSourceSpans, preRenderEntry, renderPlannedContext,
  type HostTokenizer, type SourceSpanInput } from "../../../recall/decision/budget-aware-q/render.js";

function span(startByte: number, endByte: number, overrides: Partial<SourceSpanInput> = {}): SourceSpanInput {
  return { id: "memory", sourceText: "abcdef你好🌍xyz", startByte, endByte,
    source: { workspaceId: "w", sourceObjectId: "s", sourceRevision: "r1", evidenceRefs: ["e1"] }, ...overrides };
}

describe("canonical pre-rendered source entries", () => {
  it("coalesces overlap and adjacency once in source order independently of input order", () => {
    const spans = [span(4, 12), span(0, 3), span(2, 6), span(16, 19)];
    const forward = coalesceSourceSpans(spans);
    expect(coalesceSourceSpans([...spans].reverse())).toEqual(forward);
    expect(forward).toHaveLength(1);
    expect(forward[0]!.content).toBe("abcdef你好\nxyz");
    expect(forward[0]!.sourceSpans).toEqual([{ startByte: 0, endByte: 12 }, { startByte: 16, endByte: 19 }]);
    expect(forward[0]!.framedContent).toBe("memory\nabcdef你好\nxyz\n");
  });

  it("rejects revision conflicts and split Unicode code points", () => {
    expect(() => coalesceSourceSpans([span(0, 6), span(6, 12, {
      source: { ...span(0, 1).source, sourceRevision: "r2" }
    })])).toThrow("revision conflict");
    expect(() => coalesceSourceSpans([span(6, 8)])).toThrow("UTF-8");
    expect(() => coalesceSourceSpans([span(-1, 6)])).toThrow("range");
  });

  it("owns source references and spans before later caller mutation", () => {
    const refs = ["e1"];
    const entry = preRenderEntry({ object_id: "a", content: "你好🌍", source: {
      workspaceId: "w", sourceObjectId: "s", sourceRevision: "r", evidenceRefs: refs
    } });
    refs.push("forged");
    expect(entry.source!.evidenceRefs).toEqual(["e1"]);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.source!.evidenceRefs)).toBe(true);
  });

  it("preserves exactly framed bytes and additive charge across dependency order", () => {
    const entries = [preRenderEntry({ object_id: "标题🌍", content: "你好 e\u0301\n<|endoftext|>" }),
      preRenderEntry({ object_id: "a", content: "tion\n\n" })];
    const first = renderPlannedContext(entries, ["a", "标题🌍"]);
    const reversed = renderPlannedContext(entries, ["标题🌍", "a"]);
    expect(first.context).toBe("a\ntion\n\n\n标题🌍\n你好 e\u0301\n<|endoftext|>\n");
    expect(first.actualBytes).toBe(Buffer.byteLength(first.context));
    expect(reversed.chargedTokens).toBe(first.chargedTokens);
    expect(first.chargedTokens).toBe(first.actualBytes + 64);
    expect(first.actualTokens).toBeNull();
    expect(first.tokenizerProfile).toBeNull();
    expect(renderPlannedContext([], [])).toMatchObject({ context: "", actualBytes: 0, chargedTokens: 0, envelopeAllowance: 0 });
  });

  it("rejects duplicate and stale pre-rendering and unknown tokenizer profiles", () => {
    const entry = preRenderEntry({ object_id: "a", content: "hello" });
    expect(() => renderPlannedContext([entry], ["a", "a"])).toThrow("duplicate");
    expect(() => renderPlannedContext([{ ...entry, content: "changed" }], ["a"])).toThrow("inconsistent");
    expect(() => renderPlannedContext([entry], ["missing"])).toThrow("missing");
    const unsupported = { profile: "embedding-tokenizer", implementation: "local", assetSha256: "a".repeat(64),
      encodeOrdinary: () => [] } as unknown as HostTokenizer;
    expect(() => renderPlannedContext([entry], ["a"], unsupported)).toThrow("unsupported");
    const brokenPort: HostTokenizer = { profile: "cl100k_base", implementation: "negative-fixture",
      assetSha256: "a".repeat(64), encodeOrdinary: () => Array.from({ length: 100 }, () => 1) };
    expect(() => renderPlannedContext([entry], ["a"], brokenPort)).toThrow("violates UTF-8 byte ceiling");
    expect(() => renderPlannedContext([entry], ["a"], undefined, -1)).toThrow("allowance");
  });
});

describe("mandatory offline supported host tokenizer measurement", () => {
  beforeEach(() => vi.stubGlobal("fetch", () => { throw new Error("offline tokenizer test attempted fetch"); }));
  afterEach(() => vi.unstubAllGlobals());

  it.each(["cl100k_base", "o200k_base"] as const)("measures the final selected and packed source entries with %s", async (profile) => {
    const tokenizer = await loadOfflineHostTokenizer(profile);
    const prepared = coalesceSourceSpans([span(4, 12), span(0, 6), span(16, 19), span(0, 6)]);
    const units: EvidenceUnit[] = prepared.map((entry) => ({ id: entry.object_id, content: entry.content,
      source: entry.source!, sourceSpans: entry.sourceSpans!, framedBytes: entry.framedBytes, chargedTokens: entry.chargedTokens,
      familyRanks: { lexical: 1 }, answerBindings: [], assignmentKey: null }));
    const captured = captureQuerySpec({ text: "abcdef", k: 5, tokenBudget: 2000,
      asOf: "2026-09-05T00:00:00.000Z" }, fieldContractSha256, () => "2026-09-05T00:00:00.000Z");
    const decision = withClaims(selectBudgetAwareQ({ spec: captured.spec, digest: captured.digest, units, edges: [] }), []);
    const packed = packDecision(decision, units, tokenizer);
    expect(packed.results).toHaveLength(1);
    expect(packed.results[0]!.content).toBe("abcdef你好\nxyz");
    const deliveredContext = packed.results.map((entry) => frameEntry(entry.object_id, entry.content)).join("");
    const measured = renderPlannedContext(prepared, decision.order, tokenizer, decision.envelopeAllowance);
    expect(packed.context).toBe(deliveredContext);
    expect(packed.accounting).toEqual({ actualBytes: measured.actualBytes, chargedTokens: measured.chargedTokens,
      actualTokens: measured.actualTokens, tokenizerProfile: profile });
    expect(measured.context).toBe(deliveredContext);
    expect(measured.actualBytes).toBe(decision.actualBytes);
    expect(measured.chargedTokens).toBe(decision.chargedTokens);
    expect(measured.actualTokens).toBe(tokenizer.encodeOrdinary(deliveredContext).length);
    expect(measured.actualTokens).toBeLessThanOrEqual(decision.chargedTokens);
    expect(decision.renderedEntries[0]!.source).toEqual(prepared[0]!.source);
    expect(decision.renderedEntries[0]!.sourceSpans).toEqual(prepared[0]!.sourceSpans);
  });

  it.each(["cl100k_base", "o200k_base"] as const)("measures %s across Unicode, headers, ordering and concatenation merges", async (profile) => {
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline tokenizer test attempted fetch"); });
    try {
      const tokenizer = await loadOfflineHostTokenizer(profile);
      const coalesced = coalesceSourceSpans([span(4, 12), span(0, 6), span(16, 19)]);
      const entries = [preRenderEntry({ object_id: "a", content: "text" }),
        preRenderEntry({ object_id: "\nheader", content: "你好🌍" }), ...coalesced,
        preRenderEntry({ object_id: "unicode", content: "e\u0301\t العربية 日本語\n<|endoftext|>\u0000\"\\" })];
      const orders = [entries.map((entry) => entry.object_id), [...entries].reverse().map((entry) => entry.object_id)];
      const captured = captureQuerySpec({ text: "Unicode", k: 5, tokenBudget: 2000,
        asOf: "2026-09-05T00:00:00.000Z" }, fieldContractSha256, () => "2026-09-05T00:00:00.000Z");
      const observations = orders.map((order) => {
        const units: EvidenceUnit[] = entries.map((entry) => ({ id: entry.object_id, content: entry.content,
          ...(entry.source ? { source: entry.source } : {}), ...(entry.sourceSpans ? { sourceSpans: entry.sourceSpans } : {}),
          framedBytes: entry.framedBytes, chargedTokens: entry.chargedTokens,
          familyRanks: { lexical: order.indexOf(entry.object_id) + 1 }, answerBindings: [], assignmentKey: null }));
        const decision = withClaims(selectBudgetAwareQ({ spec: captured.spec, digest: captured.digest, units, edges: [] }), []);
        const packed = packDecision(decision, units, tokenizer);
        expect(decision.order).toEqual(order);
        expect(packed.context).toBe(packed.results.map((entry) => frameEntry(entry.object_id, entry.content)).join(""));
        expect(packed.accounting.actualBytes).toBe(decision.actualBytes);
        expect(packed.accounting.chargedTokens).toBe(decision.chargedTokens);
        return { context: packed.context, ...packed.accounting };
      });
      expect(observations.map((row) => row.actualTokens)).toEqual(profile === "cl100k_base" ? [44, 44] : [36, 36]);
      expect(observations[0]!.actualBytes).toBe(105);
      expect(observations[0]!.chargedTokens).toBe(169);
      for (const observation of observations) {
        expect(observation.actualTokens).toBe(tokenizer.encodeOrdinary(observation.context).length);
        expect(observation.actualTokens).toBeGreaterThan(0);
        expect(observation.actualTokens).toBeLessThanOrEqual(observation.actualBytes);
        expect(observation.actualBytes + 64).toBe(observation.chargedTokens);
        expect(observation.chargedTokens).toBeLessThanOrEqual(2000);
        expect(observation.tokenizerProfile).toBe(profile);
      }
      expect(observations[0]!.chargedTokens).toBe(observations[1]!.chargedTokens);
      const jsonTransport = JSON.stringify(entries.map(({ object_id, content }) => ({ object_id, content })));
      expect(JSON.parse(jsonTransport)).toEqual(entries.map(({ object_id, content }) => ({ object_id, content })));
      expect(Buffer.byteLength(jsonTransport)).toBeGreaterThan(observations[0]!.actualBytes);
      const separate = tokenizer.encodeOrdinary(entries[0]!.framedContent).length + tokenizer.encodeOrdinary(entries[1]!.framedContent).length;
      const merged = tokenizer.encodeOrdinary(entries[0]!.framedContent + entries[1]!.framedContent).length;
      expect(merged).toBeLessThan(separate);
      expect(renderPlannedContext([], [], tokenizer).actualTokens).toBe(0);
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
    }
  });
});
