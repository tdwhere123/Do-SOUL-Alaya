import { describe, expect, it, vi } from "vitest";
import { SourceSemanticResourceLedger, type SourceIndexTemplateRead } from "@do-soul/alaya-protocol";
import { inspectSourceTemplate } from "../../source-index/source-template-matching.js";
import { readResources, template, templateBudget, templateStatement } from "./source-template-fixture.js";

type TestRow = Omit<ReturnType<typeof templateStatement>, "read"> & { read: SourceIndexTemplateRead };
function inspect(rows: TestRow[] = [templateStatement("one")], proposal = template) {
  const meter = new SourceSemanticResourceLedger(templateBudget), nativeBytes = vi.fn();
  const readTemplateStatements = vi.fn((source: typeof rows[number]["source"]) =>
    rows.find(row => row.source.root_key === source.root_key)!.read);
  const result = inspectSourceTemplate(proposal, rows.map(row => row.source), { readTemplateStatements }, meter, nativeBytes);
  return { result, meter, nativeBytes, readTemplateStatements };
}

describe("source-bound template matching", () => {
  it("ignores punctuation while retaining exact ordered literals in the statement and own retained message", () => {
    const row = templateStatement("one"), matched = inspect([row]);
    expect(matched.result).toMatchObject({ status: "unique", inspected_roots: 1, matched_roots: 1,
      match: { root_key: row.source.root_key, source: row.statement.source, asked_speaker: "user" } });
    const span = matched.result.match!.source_hole_span;
    expect(Buffer.from(row.body).subarray(span.start_byte, span.end_byte).toString()).toBe("Dark Souls 3");
    expect(matched.meter.spentWork).toBeGreaterThan(readResources.work);
    expect(matched.meter.spentBytes).toBeGreaterThan(readResources.memory_bytes);
    expect(matched.nativeBytes).toHaveBeenCalledWith(readResources.native_bytes);
  });

  it.each([
    "I finally beat <game> last weekend cocktail.", "I finally beat <> last weekend.",
    "I finally beat <game> <when>.", "<game> last weekend.", "I finally beat <game>"
  ])("does not invent missing literals or support an invalid frame: %s", text => {
    expect(inspect(undefined, { ...template, evidence_statements: [text] }).result.status)
      .toBe(text.includes("cocktail") ? "no_match" : "inapplicable");
  });

  it("requires the same role and literal matches in both H and the bound retained message", () => {
    const matching = "I finally beat Dark Souls 3 last weekend.";
    for (const row of [templateStatement("role", matching, matching, "assistant"),
      templateStatement("raw", matching, "You finally beat Dark Souls 3 last weekend."),
      templateStatement("statement", "I finally defeated Dark Souls 3 last weekend.", matching),
      templateStatement("empty-gap", "I finally beat last weekend."),
      templateStatement("case", "i finally beat Dark Souls 3 last weekend.")]) {
      expect(inspect([row]).result.status).toBe("no_match");
    }
  });

  it("does not join adjacent messages or substitute contextual statements", () => {
    const row = templateStatement("split", "I finally beat Dark Souls 3 last weekend.", "I finally beat Dark Souls 3.");
    expect(inspect([row]).result.status).toBe("no_match");
  });

  it("counts matching roots, not duplicate artifacts, and completes the entire original prefix", () => {
    const one = templateStatement("one"), other = templateStatement("two");
    const duplicate: SourceIndexTemplateRead = { status: "complete", statements: [one.statement, one.statement], resources: readResources };
    expect(inspect([{ ...one, read: duplicate }]).result.status).toBe("unique");
    const ambiguous = inspect([one, other]);
    expect(ambiguous.result).toMatchObject({ status: "ambiguous", inspected_roots: 2, matched_roots: 2 });
    expect(ambiguous.readTemplateStatements).toHaveBeenCalledTimes(2);
    const missing: SourceIndexTemplateRead = { status: "complete", statements: [], resources: readResources };
    expect(inspect([one, { ...other, read: missing }]).result.status).toBe("unique");
    const unknown: SourceIndexTemplateRead = { status: "unknown", reason: "stale", resources: readResources };
    expect(inspect([one, { ...other, read: unknown }]).result).toMatchObject({ status: "unknown", inspected_roots: 1, reason: "stale" });
  });

  it("preserves Unicode codepoints, combining-mark separators and UTF-8 source offsets without CJK segmentation", () => {
    const proposal = { ...template, evidence_statements: ["我 买了 <物品> 昨天。 "] };
    const row = templateStatement("unicode", "我 买了 咖啡🍵豆 昨天。"), result = inspect([row], proposal).result;
    expect(result.status).toBe("unique");
    const span = result.match!.source_hole_span;
    expect(Buffer.from(row.body).subarray(span.start_byte, span.end_byte).toString()).toBe("咖啡🍵豆");
    expect(inspect([templateStatement("compact", "我买了咖啡豆昨天。")], proposal).result.status).toBe("no_match");
    expect(inspect([templateStatement("nfc", "I finally beat café last weekend.")], {
      ...template, evidence_statements: ["I finally beat café <item> weekend."]
    }).result.status).toBe("no_match");
  });

  it("retains navigation-only semantics for quotes and negation rather than manufacturing entailment", () => {
    for (const text of ['She said "I finally beat Dark Souls 3 last weekend."',
      'It is false that "I finally beat Dark Souls 3 last weekend."']) {
      expect(inspect([templateStatement(text, text)]).result.status).toBe("unique");
    }
    expect(inspect([templateStatement("negated", "I did not finally beat Dark Souls 3 last weekend.")]).result.status).toBe("no_match");
  });

  it("refuses before native reads when token work cannot be funded and keeps already spent work", () => {
    const row = templateStatement("one"), readTemplateStatements = vi.fn(() => row.read);
    const meter = new SourceSemanticResourceLedger({ work_units: template.evidence_statements[0]!.length, memory_bytes: 1024 });
    expect(inspectSourceTemplate(template, [row.source], { readTemplateStatements }, meter, () => undefined).status).toBe("unknown");
    expect(readTemplateStatements).not.toHaveBeenCalled();
    expect(meter.spentWork).toBeGreaterThan(0);
  });
});
