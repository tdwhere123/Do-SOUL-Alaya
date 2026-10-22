import { afterAll, describe, expect, it, vi } from "vitest";
const boundary = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterAll(() => { expect(boundary.violations).toEqual([]); boundary.restore(); });
import { Ajv } from "ajv";
import { z } from "zod";
import { FormationProposalSchema, formationResponseJsonSchema, admitInputFormation, INPUT_NAVIGATION_POLICY }
  from "../../../runs/source-access-diagnostic/input-condition-formation.js";
import { evidenceSelectionCacheKey, evidenceSelectionRequestBinding, materializeEvidenceSelectionLines, parseEvidenceSelectionWorkset }
  from "../../../runs/evidence-selection/input.js";

const input = { question: "authored input", reference_clock: "2026-09-22T00:00:00.000Z" };
const cue = { query: "red stone", object: "target label", hypothesis: "unreviewed interpretation", groups: [0], residual: null };
const proposal = { status: "proposed", conditions: [cue], unresolved: [] };
const fields = [["query", 2048], ["object", 128], ["hypothesis", 128], ["residual", 8192], ["unresolved", 8192]] as const;
const payload = (field: string, value: string) => field === "unresolved" ? { ...proposal, unresolved: [value] }
  : { ...proposal, conditions: [{ ...cue, [field]: value }] };
const admit = (value: unknown) => admitInputFormation({ task: INPUT_NAVIGATION_POLICY, input, state: "complete",
  raw_json: JSON.stringify(value), provenance: "authored-string-fixture", reason: null }, input);
function patterns(value: object): string[] {
  return Object.entries(value).flatMap(([key, child]) => key === "pattern" ? [z.string().parse(child)]
    : child !== null && typeof child === "object" ? patterns(child) : []);
}

// Independent examples, not extracted from natural producer questions or responses.
const examples: [string, boolean][] = [
  ["a", true], ["red stone", true], ["赤い石 圆形盒子", true], ["إعدادات الوصول", true], ["é 😀", true],
  ["two\nlines", true], ["two\r\nlines", true], ["\nleading", true], ["trailing\n", true],
  [" \t red stone \r\n", true], ["\u2028石\u2029", true], ["\u00a0石\ufeff", true], ["\u200b", true],
  ["", false], [" ", false], ["\t\n\r\v\f", false], ["\u00a0\u1680\u2000\u2028\u2029\u202f\u205f\u3000\ufeff", false]
];

describe("formation wire string semantics", () => {
  it("accepts the same authored strings under JSON Schema search and whole-string interpretation on every nonblank field", () => {
    const schema = formationResponseJsonSchema(), validate = new Ajv().compile(schema);
    expect(patterns(schema)).toEqual(Array(5).fill("^[\\s\\S]*\\S[\\s\\S]*$"));
    for (const pattern of patterns(schema)) for (const [value, expected] of examples) {
      expect(new RegExp(pattern, "u").test(value), JSON.stringify(value)).toBe(expected);
      const match = new RegExp(`^(?:${pattern})$`, "u").exec(value);
      expect(match !== null && match[0] === value, JSON.stringify(value)).toBe(expected);
    }
    for (const [field] of fields) for (const [value, expected] of examples) {
      const raw = payload(field, value);
      expect(validate(raw), `${field}: ${JSON.stringify(value)}`).toBe(expected);
      expect(FormationProposalSchema.safeParse(raw).success).toBe(expected);
      expect(admit(raw).available).toBe(expected);
      if (expected) expect(JSON.parse(admit(raw).capture.raw_json!)).toEqual(raw);
    }
    // Search semantics never imposed a one-character limit; a full-string reading of the old pattern does.
    expect(new RegExp("\\S", "u").test("red stone")).toBe(true);
    expect(new RegExp("^(?:\\S)$", "u").test("red stone")).toBe(false);
  });

  it("preserves nonblank language over bounded combinations including line terminators and non-ASCII whitespace", () => {
    const pattern = patterns(formationResponseJsonSchema())[0]!;
    const alphabet = ["a", "石", " ", "\n", "\r", "\u00a0", "\u2028"];
    const validate = new Ajv().compile({ type: "string", minLength: 1, pattern });
    let level = [""];
    for (let length = 0; length <= 4; length++) {
      for (const value of level) {
        const expected = value.includes("a") || value.includes("石");
        expect(validate(value)).toBe(expected);
        const match = new RegExp(pattern, "u").exec(value);
        expect(match !== null && match[0] === value).toBe(expected);
      }
      level = level.flatMap(value => alphabet.map(character => value + character));
    }
  });

  it("retains all field limits independently of newline matching and strict object boundaries", () => {
    const validate = new Ajv().compile(formationResponseJsonSchema());
    for (const [field, max] of fields) for (const character of ["x", "石", "\n"]) {
      for (const length of [max, max + 1]) {
        const raw = payload(field, `x${character.repeat(length - 1)}`);
        expect(validate(raw)).toBe(length === max);
        expect(FormationProposalSchema.safeParse(raw).success).toBe(length === max);
        expect(admit(raw).available).toBe(length === max);
      }
    }
    for (const raw of [{ ...proposal, extra: true }, { ...proposal, conditions: [{ ...cue, extra: true }] },
      { ...proposal, conditions: Array(4).fill(cue) }, { ...proposal, unresolved: Array(9).fill("reason") },
      ...[[], [3], [0, 1, 2, 0]].map(groups => ({ ...proposal, conditions: [{ ...cue, groups }] }))]) {
      expect(validate(raw)).toBe(false); expect(admit(raw).available).toBe(false);
    }
    for (const raw of [{ ...proposal, conditions: [cue, { ...cue, groups: [1] }] },
      { ...proposal, conditions: [{ ...cue, groups: [0, 0] }] },
      ...[{ object: "other target" }, { hypothesis: "other interpretation" }].map(change => ({ ...proposal,
        conditions: [cue, { ...cue, ...change, query: "round stone" }] }))]) {
      // These cross-carrier invariants belong to admission, not to the JSON Schema string constraint.
      expect(validate(raw)).toBe(true); expect(admit(raw)).toMatchObject({ state: "rejected", available: false });
    }
  });

  it("changes exact request and cache identity through the existing owner without changing policy or profile", () => {
    const workset = parseEvidenceSelectionWorkset({ contract: "source-evidence-selection-workset-v1", model: "step-3.5-flash-2603",
      provider_url: "https://api.stepfun.com/v1", request_profile: "step-3.5-2603-low-json-schema-v1", request_policy: INPUT_NAVIGATION_POLICY,
      items: [{ original_question: input.question, metadata: { reference_clock: input.reference_clock }, sources: [] }] });
    const line = materializeEvidenceSelectionLines(workset, 8192)[0]!;
    // Authored prior representation only: no historical cache is opened, admitted or reclassified.
    const previous = JSON.parse(JSON.stringify(line.responseJsonSchema).replaceAll(
      JSON.stringify("^[\\s\\S]*\\S[\\s\\S]*$"), JSON.stringify("\\S")));
    expect(patterns(previous)).toEqual(Array(5).fill("\\S"));
    const key = (schema: object) => evidenceSelectionCacheKey({ model: workset.model, requestProfile: workset.request_profile,
      providerUrl: workset.provider_url, systemPrompt: line.systemPrompt, userPrompt: line.userPrompt, schema, maxOutputTokens: 8192 });
    const binding = (responseJsonSchema: object) => evidenceSelectionRequestBinding({ model: workset.model,
      requestProfile: "step-3.5-2603-low-json-schema-v1", providerUrl: workset.provider_url, apiKey: null },
    { systemPrompt: line.systemPrompt, userPrompt: line.userPrompt, responseJsonSchema, maxOutputTokens: 8192 });
    expect(key(line.responseJsonSchema)).toBe(line.key);
    expect(binding(line.responseJsonSchema).requestDigest).toBe(line.requestDigest);
    expect(key(previous)).not.toBe(line.key);
    expect(binding(previous).requestDigest).not.toBe(line.requestDigest);
    expect(workset.request_policy).toBe("input-only-navigation-search-cues.v4");
  });
});
