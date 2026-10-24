import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
const boundary = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterAll(() => { expect(boundary.violations).toEqual([]); boundary.restore(); });
import { Ajv } from "ajv";
import { fetchLoopbackProvider } from "../../support/loopback-provider-fetch.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INPUT_NAVIGATION_POLICY, FormationCaptureSchema, admitInputFormation, formationQueryShares, formationResponseJsonSchema, mechanicalFormation,
  type FormationCapture } from "../../../runs/source-access-diagnostic/input-condition-formation.js";
import { runNavigationProposals } from "../../../runs/source-access-diagnostic/conditional-navigation-propose.js";
import { solveConditionalNavigation } from "../../../runs/source-access-diagnostic/conditional-navigation.js";
import { materializeEvidenceSelectionLines, parseEvidenceSelectionWorkset } from "../../../runs/evidence-selection/input.js";
import { readProviderRawAttempt } from "../../../runs/extraction/fill/provider-raw-attempt.js";
import { readProviderResponseWithEvidence, MAX_COMPLETE_PROVIDER_HTTP_RESPONSE_BYTES } from "../../../../../../packages/engine-gateway/src/provider/chat-completion/response-evidence.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const input = { question: "赤い石\n圆形盒子", reference_clock: "2026-09-22T00:00:00.000Z" };
const condition = (id: string) => ({ id, object: "target", hypothesis: "hypothesis", query: id, status: "ready" as const, residual: null });
const cue = (query: string, groups = [0]) => ({ query, object: "target", hypothesis: "hypothesis", groups, residual: null as string | null });
const proposal = () => ({ status: "proposed", conditions: [cue("red"), cue("round")], unresolved: ["identity unreviewed"] });
const captured = (raw: unknown): FormationCapture => ({ task: INPUT_NAVIGATION_POLICY, input, state: "complete",
  raw_json: JSON.stringify(raw), provenance: "authored-local-task", reason: null });

describe("input-only condition formation", () => {
  it("uses generic literal boundaries without inventing object identity or conjunctions", () => {
    const result = admitInputFormation(mechanicalFormation(input), input);
    expect(result).toMatchObject({ available: true, state: "partial", branches: [["formed-0"], ["formed-1"]] });
    expect(result.conditions.map(row => [row.query, row.object])).toEqual([["赤い石", "line-0"], ["圆形盒子", "line-1"]]);
    const one = { ...input, question: "متى حدث ذلك؟" };
    expect(admitInputFormation(mechanicalFormation(one), one)).toMatchObject({ available: true, state: "ready", conditions: [] });
  });
  it("establishes only structural search readiness while fidelity and source truth remain unverified", () => {
    const raw = { ...proposal(), conditions: [{ ...cue("red"), residual: "remaining" }, cue("round")] };
    expect(admitInputFormation(captured(raw), input)).toMatchObject({ state: "partial", available: true,
      interpretation_fidelity: "unverified", conditions: [{ status: "partial", residual: "remaining" }, { status: "ready" }] });
    for (const state of ["rejected", "unsupported", "unknown", "unavailable", "transport_failure", "incomplete"] as const) {
      expect(admitInputFormation({ ...captured(null), state }, input)).toMatchObject({ state, available: false });
    }
  });
  it("rejects malformed, legacy cross-references, mixed contexts and producer identity or status overrides", () => {
    const base = proposal();
    for (const raw of [null, { ...base, branches: [["absent"]] },
      { ...base, conditions: [cue("red"), { ...cue("round"), object: "other" }] },
      { ...base, conditions: [cue("red"), { ...cue("round"), hypothesis: "other" }] },
      ...[{ id: "invented" }, { status: "unknown" }, { status: "ready" }, { groups: [] }, { groups: [0, 0] },
        { groups: [3] }, { groups: ["missing"] }, { residual: "" }, { query: " \n " },
        { object: " " }, { hypothesis: " " }, { residual: " " }].map(overrides => ({ ...base, conditions: [{ ...cue("red"), ...overrides }] })),
      { ...base, conditions: [cue("red"), cue("red", [1])] }]) {
      expect(admitInputFormation(captured(raw), input)).toMatchObject({ state: "rejected", available: false, conditions: [] });
    }
    expect(() => admitInputFormation(captured(base), { ...input, reference_clock: "2026-09-23T00:00:00.000Z" })).toThrow(/captured authority/u);
    expect(() => admitInputFormation(captured(base), { ...input, question: "changed" })).toThrow(/captured authority/u);
  });
  it("owns structural IDs, shares only exact compatible occurrences and preserves max/min paths", () => {
    const result = admitInputFormation(captured({ ...proposal(), conditions: [cue("red", [0, 1]), cue("round"), cue("small", [1])] }), input);
    expect(result.branches).toEqual([["formed-0", "formed-1"], ["formed-0", "formed-2"]]);
    expect(result.conditions.map(row => [row.id, row.query])).toEqual([["formed-0", "red"], ["formed-1", "round"], ["formed-2", "small"]]);
    const original = { ...condition("original"), provenance: "authored-original" };
    const hit = (condition: string, record_id: string, native_rank: number, channel: "lexical" | "vector" = "lexical") =>
      ({ condition, record_id, native_rank, channel, root_key: record_id, reference: `${condition}:${record_id}` });
    const solved = solveConditionalNavigation({ original: "original", conditions: [original, ...result.conditions], branches: result.branches,
      pool: ["a", "b"].map((record_id, catalog_position) => ({ record_id, catalog_position })),
      occurrences: [hit("original", "a", 1, "vector"), hit("formed-0", "b", 1), hit("formed-0", "a", 2),
        hit("formed-1", "a", 1), hit("formed-1", "b", 2), hit("formed-2", "b", 1)] });
    expect(solved.rows.map(row => [row.record_id, row.navigation.tier])).toEqual([["b", 1024], ["a", 1023]]);
    expect(solved.assessments.filter(row => row.record_id === "b").map(row => row.tier)).toEqual([null, 1022, 1024]);
    expect(solved.rows.every(row => row.read.status === "unobserved" && row.conditional_support.status === "unknown")).toBe(true);
    const shares = formationQueryShares([original, ...result.conditions], true, original.id);
    expect(shares.size).toBe(4);
    expect([...shares.values()].reduce((sum, row) => sum + row.allowance.max_attempts, 0)).toBe(127);
    expect(admitInputFormation(captured({ ...proposal(), conditions: [cue("red"), cue("round"), cue("small"), cue("bright")] }), input))
      .toMatchObject({ available: false, state: "rejected" });
  });
  it.each([
    { reserved: ["formed-0"], expected: ["formed-1", "formed-2", "formed-3"] },
    { reserved: ["formed-1"], expected: ["formed-0", "formed-2", "formed-3"] },
    { reserved: ["formed-2"], expected: ["formed-0", "formed-1", "formed-3"] },
    { reserved: ["formed-0", "formed-1", "formed-2"], expected: ["formed-3", "formed-4", "formed-5"] }
  ])("allocates shared condition IDs outside reserved input identities: $reserved", ({ reserved, expected }) => {
    const capture = captured({ ...proposal(), conditions: [cue("red", [0, 1]), cue("round"), cue("small", [1])] });
    const before = structuredClone(capture);
    const result = admitInputFormation(capture, input, Object.freeze(reserved));
    expect(result).toMatchObject({ available: true, state: "partial" });
    expect(result.conditions.map(row => row.id)).toEqual(expected);
    expect(result.conditions.map(row => row.query)).toEqual(["red", "round", "small"]);
    expect(result.branches).toEqual([[expected[0], expected[1]], [expected[0], expected[2]]]);
    expect(admitInputFormation(capture, input, reserved)).toEqual(result);
    expect(capture).toEqual(before);
    const mechanical = admitInputFormation(mechanicalFormation(input), input, reserved);
    expect(mechanical.conditions.map(row => row.id)).toEqual(expected.slice(0, 2));
    expect(mechanical.branches).toEqual([[expected[0]], [expected[1]]]);
  });
  it("keeps comparison objects and ambiguous temporal hypotheses separate without resolving them", () => {
    const temporalInput = { question: "先月の私の転居と、姉の転居はどちらが先？", reference_clock: "2026-06-15T12:00:00.000Z" };
    const raw = { status: "proposed", conditions: [
      { ...cue("私の転居 先月"), object: "私", hypothesis: "先月の解釈は未確定", residual: "先月の範囲が曖昧" },
      { ...cue("姉の転居", [1]), object: "姉", hypothesis: "先月の解釈は未確定" },
      { ...cue("私の転居 先月", [2]), object: "私", hypothesis: "暦月か直近の期間か未確定" }
    ], unresolved: ["先月の範囲と出来事の日時は未確定。比較には両方の記録が必要。"] };
    const result = admitInputFormation({ ...captured(raw), input: temporalInput }, temporalInput);
    expect(result).toMatchObject({ available: true, state: "partial", branches: [["formed-0"], ["formed-1"], ["formed-2"]], unresolved: raw.unresolved });
    expect(result.conditions.map(({ object, hypothesis, query, status, residual }) => ({ object, hypothesis, query, status, residual })))
      .toEqual(raw.conditions.map(({ groups: _groups, ...row }) => ({ ...row, status: row.residual === null ? "ready" : "partial" })));
    expect(result.capture.input).toEqual(temporalInput);
  });
  it.each([
    { question: "ما الذي تغيّر في إعدادات وصولي منذ المراجعة السابقة؟", query: "إعدادات وصولي منذ المراجعة السابقة", residual: "مرجع المراجعة السابقة غير محدد" },
    { question: "Compare la durée du trajet de Léa et de Noé, sans les pauses.", query: "trajet de Léa sans les pauses", residual: "Le trajet de Noé reste à former" }
  ])("retains authored multilingual retrieval restrictions and uncertainty: $question", ({ question, query, residual }) => {
    const value = { ...input, question };
    const raw = { status: "proposed", conditions: [{ ...cue(query), residual }], unresolved: [residual] };
    const result = admitInputFormation({ ...captured(raw), input: value }, value);
    expect(result).toMatchObject({ available: true, state: "partial", conditions: [{ query, residual, status: "partial" }], unresolved: [residual] });
    expect(JSON.parse(result.capture.raw_json!)).toEqual(raw);
  });
  it("distinguishes valid-empty, unusable, unobserved conditions and invalid state combinations", () => {
    expect(admitInputFormation(captured({ status: "proposed", conditions: [], unresolved: ["No distinct cue identified."] }), input))
      .toMatchObject({ available: true, state: "ready", conditions: [], branches: [] });
    for (const status of ["unsupported", "cannot_propose"] as const) {
      expect(admitInputFormation(captured({ status, conditions: [], unresolved: ["Unusable input."] }), input))
        .toMatchObject({ available: false, state: status === "unsupported" ? "unsupported" : "declined" });
      expect(admitInputFormation(captured({ ...proposal(), status }), input)).toMatchObject({ available: false, state: "rejected" });
    }
    for (const status of ["proposed", "unsupported", "cannot_propose"]) {
      expect(admitInputFormation(captured({ status, conditions: [], unresolved: [] }), input)).toMatchObject({ available: false, state: "rejected" });
    }
    // Existing genuinely unknown conditions are not promoted by the new producer adapter.
    const unknown = ["unknown", "unsupported", "rejected"] as const;
    expect(formationQueryShares(unknown.map(status => ({ ...condition(status), status, provenance: "observed-fixture" })), true, "observed-original").size).toBe(0);
  });
  it("rejects historical captures and carriers rather than retroactively admitting their references", () => {
    for (const task of ["input-only-navigation-proposal.v1", "input-only-navigation-proposal.v2", "input-only-navigation-proposal.v3"]) {
      expect(() => FormationCaptureSchema.parse({ ...captured(proposal()), task })).toThrow();
    }
    const legacy = { status: "partial", conditions: [condition("red")], branches: [["red"]], unresolved: ["authored legacy carrier"] };
    expect(admitInputFormation(captured(legacy), input)).toMatchObject({ available: false, state: "rejected" });
    expect(admitInputFormation(captured({ ...legacy, conditions: [], branches: [["undeclared source-search text"]] }), input))
      .toMatchObject({ available: false, state: "rejected" });
    expect(formationResponseJsonSchema()).toMatchObject({ required: ["status", "conditions", "unresolved"],
      properties: { conditions: { maxItems: 3, items: { required: ["query", "object", "hypothesis", "groups", "residual"],
        additionalProperties: false, properties: { groups: { minItems: 1, maxItems: 3, items: { minimum: 0, maximum: 2 } } } } } } });
  });
  it("enforces the TOTAL carrier bound in the wire JSON schema before any global admission rule", () => {
    const validate = new Ajv().compile(formationResponseJsonSchema());
    expect(validate({ ...proposal(), conditions: [cue("A", [0, 1]), cue("B"), cue("C", [1])] })).toBe(true);
    for (const count of [4, 6]) {
      expect(validate({ ...proposal(), conditions: Array.from({ length: count }, (_, i) => cue(`cue-${i}`, [i % 3])) })).toBe(false);
      expect(validate.errors).toEqual(expect.arrayContaining([expect.objectContaining({ keyword: "maxItems", instancePath: "/conditions" })]));
    }
  });
  it("preserves every bounded three-carrier membership pattern without merging equal labels", () => {
    for (let a = 1; a < 8; a++) for (let b = 1; b < 8; b++) for (let c = 1; c < 8; c++) {
      const masks = [a, b, c];
      const conditions = masks.map((mask, i) => cue(`cue-${i}`, [0, 1, 2].filter(group => (mask & (1 << group)) !== 0)));
      const result = admitInputFormation(captured({ ...proposal(), conditions }), input);
      const expected = [1, 2, 4].map(bit => masks.flatMap((mask, i) => (mask & bit) !== 0 ? [`formed-${i}`] : []))
        .filter(ids => ids.length > 0);
      expect(result.branches).toEqual(expected);
      expect(result.conditions).toHaveLength(3);
    }
  });
  it("keeps same-query carriers in different object or hypothesis contexts distinct", () => {
    const raw = { ...proposal(), conditions: [cue("same", [0]), { ...cue("same", [1]), object: "other" },
      { ...cue("same", [2]), hypothesis: "alternative" }] };
    const result = admitInputFormation(captured(raw), input);
    expect(result.conditions.map(row => [row.id, row.object, row.hypothesis])).toEqual([
      ["formed-0", "target", "hypothesis"], ["formed-1", "other", "hypothesis"], ["formed-2", "target", "alternative"]]);
    expect(result.branches).toEqual([["formed-0"], ["formed-1"], ["formed-2"]]);
    expect(formationQueryShares(result.conditions, true, "formed-0").size).toBe(3);
  });
  it("reserves half for the caller's original identity in any supplied or formed order and never recycles unused shares", () => {
    const originalShare = { allowance: { max_attempts: 64, max_roots: 8, max_vector_windows: 2048 },
      budget: { work_units: 25_000_000, memory_bytes: 30_000_000 } };
    const extraShare = { allowance: { max_attempts: 21, max_roots: 2, max_vector_windows: 682 },
      budget: { work_units: 8_333_333, memory_bytes: 10_000_000 } };
    const totals = [127, 14, 4094, 49_999_999, 60_000_000];
    const ready = (id: string, status: "ready" | "partial" = "ready") => ({ ...condition(id), status,
      residual: status === "partial" ? "unresolved fragment" : null, provenance: "authored-share-fixture" });
    const measure = (shares: ReturnType<typeof formationQueryShares>) => [...shares.values()].reduce((sums, row) => sums.map((sum, i) => sum +
      [row.allowance.max_attempts, row.allowance.max_roots, row.allowance.max_vector_windows, row.budget.work_units, row.budget.memory_bytes][i]!), [0, 0, 0, 0, 0]);
    const expectHalf = (rows: Parameters<typeof formationQueryShares>[0], originalId: string, extraIds: string[]) => {
      const shares = formationQueryShares(rows, true, originalId);
      expect(shares.get(originalId)).toEqual(originalShare);
      expect(extraIds.map(id => shares.get(id))).toEqual(extraIds.map(() => extraShare));
      expect(shares.size).toBe(1 + extraIds.length);
      expect(measure(shares)).toEqual(totals);
    };
    const originalId = "question-cue", extraIds = ["red", "round", "small"];
    const extras = () => [ready("red"), ready("round", "partial"), ready("small")];
    const original = () => ready(originalId);
    expectHalf([original(), ...extras()], originalId, extraIds);
    expectHalf([extras()[0]!, original(), extras()[1]!, extras()[2]!], originalId, extraIds);
    expectHalf([...extras(), original()], originalId, extraIds);
    expectHalf([{ ...ready("time"), observation_window: { contract: "benchmark-session-window.v1" as const, coordinate: "normalized_session_coordinate" as const,
      from: "2021-02-03T12:00:00.000Z", until: "2021-02-03T12:01:00.000Z" } }, { ...ready("dropped"), status: "unknown" as const },
      ...extras(), original()], originalId, extraIds);
    const formed = admitInputFormation(captured({ ...proposal(), conditions: extraIds.map(query => cue(query)) }), input).conditions;
    expect(formed.map(row => row.id)).toEqual(["formed-0", "formed-1", "formed-2"]);
    expectHalf([original(), ...formed], originalId, formed.map(row => row.id));
    expectHalf([formed[0]!, original(), formed[1]!, formed[2]!], originalId, formed.map(row => row.id));
    expectHalf([...formed, original()], originalId, formed.map(row => row.id));
    const colliding = ready("formed-0");
    const reserved = admitInputFormation(captured({ ...proposal(), conditions: extraIds.map(query => cue(query)) }), input, [colliding.id]);
    expect(reserved.conditions.map(row => row.id)).toEqual(["formed-1", "formed-2", "formed-3"]);
    expectHalf([reserved.conditions[0]!, colliding, reserved.conditions[1]!, reserved.conditions[2]!], colliding.id,
      reserved.conditions.map(row => row.id));
    expect(formationQueryShares([original()], true, originalId).get(originalId)).toEqual({
      allowance: { max_attempts: 128, max_roots: 16, max_vector_windows: 4096 },
      budget: { work_units: 50_000_000, memory_bytes: 60_000_000 } });
  });
  it("keeps an unbound original as admission failure rather than first-row share identity", () => {
    expect(() => solveConditionalNavigation({ original: "absent", conditions: [{ ...condition("ready-cue"), provenance: "authored-admission-fixture" }],
      branches: [], pool: [], occurrences: [] })).toThrow(/ambiguous navigation identity/u);
  });
  it("binds only question and clock and rejects corpus or extra contextual metadata", () => {
    const workset = { contract: "source-evidence-selection-workset-v1", model: "step-3.5-flash-2603",
      provider_url: "https://api.stepfun.com/v1", request_profile: "step-3.5-2603-low-json-schema-v1", request_policy: INPUT_NAVIGATION_POLICY,
      items: [{ original_question: input.question, metadata: { reference_clock: input.reference_clock }, sources: [] }] };
    const [line] = materializeEvidenceSelectionLines(parseEvidenceSelectionWorkset(workset), 8192);
    expect(JSON.parse(line!.userPrompt)).toEqual(input);
    expect(line!.inputByteUpper).toBeLessThan(16 * 1024);
    expect(() => materializeEvidenceSelectionLines(parseEvidenceSelectionWorkset({ ...workset,
      items: [{ ...workset.items[0], metadata: { reference_clock: input.reference_clock, answer: "forbidden" } }] }), 8192)).toThrow();
    expect(() => parseEvidenceSelectionWorkset({ ...workset, request_policy: "input-only-navigation-proposal.v1" })).toThrow();
  });
});

it("refuses actual model drift from the frozen task authority before any issuance", async () => {
  const root = mkdtempSync(join(tmpdir(), "input-navigation-drift-")); roots.push(root);
  const extract = vi.fn(async () => ({ rawJson: "{}" }));
  const result = await runNavigationProposals({ source_revision: "authored-native-owner-fixture", rows: [{ ordinal: 1, input }] },
    join(root, "provider"), { model: "different-model", providerUrl: "https://api.stepfun.com/v1",
      requestProfile: "step-3.5-2603-low-json-schema-v1", apiKey: "authored-local-test-auth" }, { extract });
  expect(extract).not.toHaveBeenCalled();
  expect(result).toMatchObject({ status: "stopped", failure: expect.stringContaining("execution config differs"),
    cost: { actual_provider_calls: 0, outstanding_maximum_cny: 0.15 } });
});

it("preserves missing-raw native reservations as unknown formation with the original failure reason", async () => {
  const root = mkdtempSync(join(tmpdir(), "input-navigation-unresolved-")); roots.push(root);
  const values = { source_revision: "authored-missing-raw-fixture", rows: [1, 2].map(ordinal => ({ ordinal,
    input: { ...input, question: `authored ${ordinal}` } })) };
  const extract = vi.fn(async () => { throw new Error("authored failure after reservation before raw publication"); });
  const result = await runNavigationProposals(values, join(root, "provider"), {
    model: "step-3.5-flash-2603", providerUrl: "https://api.stepfun.com/v1",
    requestProfile: "step-3.5-2603-low-json-schema-v1", apiKey: "authored-local-test-auth"
  }, { extract });
  expect(extract).toHaveBeenCalledTimes(1);
  expect(result.ledger).toMatchObject({ attempts: 1, unresolvedAttempts: [{ cacheKey: expect.any(String), attemptOrdinal: 1 }] });
  expect(result.cost.unknown_usage_attempts).toBe(1);
  expect(result.cost.outstanding_maximum_cny).toBeGreaterThan(0.15);
  expect(result.captures.map(row => row.capture.state)).toEqual(["unknown", "unavailable"]);
  expect(result.captures[0]!.capture).toMatchObject({ raw_json: null, reason: "authored failure after reservation before raw publication" });
  expect(admitInputFormation(result.captures[0]!.capture, values.rows[0]!.input)).toMatchObject({
    state: "unknown", available: false, unresolved: ["authored failure after reservation before raw publication"] });
});

it("clips the fourth fourteen-minute request to the remaining three minutes and retains its unknown reservation", async () => {
  const root = mkdtempSync(join(tmpdir(), "input-navigation-deadline-")); roots.push(root);
  const rawJson = JSON.stringify({ status: "proposed", conditions: [], unresolved: ["No extra navigation."] });
  const usage = { inputTokens: 100, outputTokens: 80, totalTokens: 180 };
  const httpResponse = (await readProviderResponseWithEvidence(new Response(JSON.stringify({
    choices: [{ message: { content: rawJson }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 80, total_tokens: 180 }
  }), { headers: { "content-type": "application/json" } }), undefined, MAX_COMPLETE_PROVIDER_HTTP_RESPONSE_BYTES)).evidence;
  const timeouts: number[] = [];
  let now = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  try {
    const result = await runNavigationProposals({ source_revision: "authored-phase-fixture",
      rows: Array.from({ length: 8 }, (_, i) => ({ ordinal: i + 1, input: { ...input, question: `authored ${i}` } })) },
    join(root, "provider"), { model: "step-3.5-flash-2603", providerUrl: "https://api.stepfun.com/v1",
      requestProfile: "step-3.5-2603-low-json-schema-v1", apiKey: "authored-local-test-auth" },
    { extract: async request => {
      timeouts.push(request.timeoutMs!);
      if (request.timeoutMs! < 14 * 60_000) { now += request.timeoutMs!; throw new Error("authored phase deadline cancellation"); }
      now += 14 * 60_000;
      return { rawJson, usage, httpResponse, responseMetadata: { finishReason: "stop" } };
    } });
    expect(timeouts).toEqual([15 * 60_000, 15 * 60_000, 15 * 60_000, 3 * 60_000]);
    expect(now).toBe(45 * 60_000);
    expect(result.ledger.attempts).toBe(4);
    expect(result.ledger.unresolvedAttempts).toHaveLength(1);
    expect(result.cost.unknown_usage_attempts).toBe(1);
    expect(result.cost.outstanding_maximum_cny).toBeGreaterThan(0.15);
    expect(result.captures.map(row => row.capture.state)).toEqual(["complete", "complete", "complete", "unknown",
      "unavailable", "unavailable", "unavailable", "unavailable"]);
  } finally { clock.mockRestore(); }
});

it.each(["flat", "legacy-reference"] as const)("captures native Step wire and admits only the bound search-cue contract: %s", async mode => {
  const root = mkdtempSync(join(tmpdir(), "input-navigation-native-capture-")); roots.push(root);
  const urls: string[] = [], bodies: string[] = [];
  const rawJson = JSON.stringify(mode === "flat" ? proposal()
    : { status: "partial", conditions: [], branches: [["undeclared authored query"]], unresolved: ["unresolved reference"] });
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += String(chunk); bodies.push(body);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: rawJson }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 80, total_tokens: 180 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing fixture port");
  const origin = `http://127.0.0.1:${address.port}`;
  const guardedFetch = globalThis.fetch;
  // Authored Step wire fixture: only this exact pinned endpoint is adapted to loopback.
  // Every physical fetch still crosses the pre-import nonloopback/no-redirect guard.
  globalThis.fetch = (url, init) => {
    const target = String(url); urls.push(target);
    return target === "https://api.stepfun.com/v1/chat/completions"
      ? fetchLoopbackProvider(guardedFetch, new URL("/v1/chat/completions", origin), init) : guardedFetch(url, init);
  };
  const oldPrivate = process.env.ALAYA_ALLOW_PRIVATE_PROVIDER_URL;
  process.env.ALAYA_ALLOW_PRIVATE_PROVIDER_URL = "true";
  try {
    const config = { model: "step-3.5-flash-2603", providerUrl: "https://api.stepfun.com/v1",
      requestProfile: "step-3.5-2603-low-json-schema-v1" as const, apiKey: "authored-local-test-auth" };
    const values = { source_revision: "authored-native-capture-fixture", rows: [{ ordinal: 1, input: { ...input } }] };
    const pending = runNavigationProposals(values, join(root, "provider"), config);
    config.providerUrl = `${origin}/mutated-route`;
    values.rows[0]!.input.question = "mutated question";
    const result = await pending;
    expect(urls).toEqual(["https://api.stepfun.com/v1/chat/completions"]);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toContain("mutated question");
    const wire = JSON.parse(bodies[0]!);
    expect(wire).toMatchObject({ stream: true, max_tokens: 8192, reasoning_effort: "low",
      response_format: { type: "json_schema", json_schema: { strict: true, schema: formationResponseJsonSchema() } } });
    expect(wire.response_format.json_schema.schema.properties.conditions.maxItems).toBe(3);
    expect(wire.response_format.json_schema.schema.properties.branches).toBeUndefined();
    expect(JSON.parse(wire.messages[1].content)).toEqual(input);
    expect(result.captures[0]!.capture.input).toEqual(input);
    expect(result.captures[0]!.capture.raw_json).toBe(rawJson);
    expect(result.status).toBe(mode === "flat" ? "complete" : "stopped");
    const admitted = admitInputFormation(result.captures[0]!.capture, input);
    if (mode === "flat") expect(admitted).toMatchObject({ state: "partial", available: true,
      branches: [["formed-0", "formed-1"]], conditions: [{ query: "red" }, { query: "round" }] });
    else expect(admitted).toMatchObject({ state: "rejected", available: false, conditions: [], branches: [] });
    expect(config.providerUrl).toBe(`${origin}/mutated-route`);
  } finally {
    globalThis.fetch = guardedFetch;
    if (oldPrivate === undefined) delete process.env.ALAYA_ALLOW_PRIVATE_PROVIDER_URL;
    else process.env.ALAYA_ALLOW_PRIVATE_PROVIDER_URL = oldPrivate;
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it("loads authored native credentials in the guarded proposal CLI and retains a valid-empty response", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { fileURLToPath } = await import("node:url");
  const root = mkdtempSync(join(tmpdir(), "input-navigation-cli-")); roots.push(root);
  let requests = 0;
  const server = createServer(async (req, res) => {
    requests++; req.resume();
    expect(req.headers.authorization).toBe("Bearer test-key");
    const content = JSON.stringify({ status: "proposed", conditions: [], unresolved: ["Authored empty result."] });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 80, total_tokens: 180 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing fixture port");
  try {
    const path = join(root, "input.json"), output = join(root, "provider");
    writeFileSync(path, JSON.stringify({ source_revision: "authored-native-cli-fixture", rows: [{ ordinal: 1, input }] }));
    const cli = fileURLToPath(new URL("../../../../dist/runs/source-access-diagnostic/conditional-navigation-launch.js", import.meta.url));
    const preload = new URL("../../support/transport-diagnostic-bootstrap.mjs", import.meta.url).href;
    const { stdout } = await promisify(execFile)(process.execPath, ["--import", preload, cli, "--propose", path, "--out", output], {
      env: { ...process.env, ALAYA_TEST_LOOPBACK_TARGET: `http://127.0.0.1:${address.port}`,
        ALAYA_TEST_DIAGNOSTIC_MODE: "transport" }, timeout: 10_000
    });
    expect(requests).toBe(1);
    const receipt = JSON.parse(stdout);
    expect(receipt).toMatchObject({ status: "complete", cost: { actual_provider_calls: 1, historical_unresolved_cny: 0.15 } });
    expect(admitInputFormation(receipt.captures[0].capture, input)).toMatchObject({ state: "ready", available: true, conditions: [] });
    expect(JSON.parse(readFileSync(join(output, "receipt.json"), "utf8"))).toEqual(receipt);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it.each(["valid", "unknown", "malformed", "incomplete", "unsupported"] as const)("freezes native authority and reservations; handles %s without retry", async mode => {
  const unknownUsage = mode === "unknown", complete = mode === "valid";
  const root = mkdtempSync(join(tmpdir(), "input-navigation-authority-")); roots.push(root);
  const output = join(root, "provider");
  const rawJson = mode === "malformed" ? "not-json" : mode === "unsupported"
    ? JSON.stringify({ status: "unsupported", conditions: [], unresolved: ["unusable input"] }) : JSON.stringify(proposal());
  const finishReason = mode === "incomplete" ? "length" : "stop";
  const usage = { inputTokens: 100, outputTokens: 80, totalTokens: 180 };
  const evidence = (await readProviderResponseWithEvidence(new Response(JSON.stringify({ choices: [{ message: { content: rawJson }, finish_reason: finishReason }],
    ...(!unknownUsage ? { usage: { prompt_tokens: 100, completion_tokens: 80, total_tokens: 180 } } : {}) }),
  { headers: { "content-type": "application/json" } }), undefined, MAX_COMPLETE_PROVIDER_HTTP_RESPONSE_BYTES)).evidence;
  let reservations = 0;
  const extract = vi.fn(async () => {
    const request = JSON.parse(readFileSync(join(output, "request.json"), "utf8"));
    const ledger = JSON.parse(readFileSync(join(output, "cache", `extraction-attempt-ledger.${request.authority.attempt_lineage_digest}.json`), "utf8"));
    reservations++;
    expect(ledger.attempts).toBe(reservations);
    expect(request.authority.limits.maximum_attempts_per_key).toBe(1);
    expect(request.reservation.policy_upper_cny).toBeLessThanOrEqual(0.25);
    expect(request.reservation.historical_unresolved_cny).toBe(0.15);
    return { rawJson, responseMetadata: { finishReason }, httpResponse: evidence, ...(!unknownUsage ? { usage } : {}) };
  });
  const values = { source_revision: "authored-native-owner-fixture", rows: [1, 2].map(ordinal => ({ ordinal,
    input: { ...input, question: `${input.question} ${ordinal}` } })) };
  const config = { model: "step-3.5-flash-2603", providerUrl: "https://api.stepfun.com/v1",
    requestProfile: "step-3.5-2603-low-json-schema-v1" as const, apiKey: "authored-local-test-auth" };
  const result = await runNavigationProposals(values, output, config, { extract });
  expect(extract).toHaveBeenCalledTimes(complete ? 2 : 1);
  expect(result.status).toBe(complete ? "complete" : "stopped");
  expect(result.cost.unknown_usage_attempts).toBe(unknownUsage ? 1 : 0);
  expect(result.cost.outstanding_maximum_cny).toBeGreaterThanOrEqual(0.15);
  expect(result.captures.map(row => row.capture.state)).toEqual(complete ? ["complete", "complete"]
    : [unknownUsage ? "unknown" : mode === "unsupported" ? "complete" : mode === "malformed" ? "malformed" : "incomplete", "unavailable"]);
  if (mode === "unsupported") expect(admitInputFormation(result.captures[0]!.capture, values.rows[0]!.input)).toMatchObject({ state: "unsupported", available: false });
  const request = JSON.parse(readFileSync(join(output, "request.json"), "utf8"));
  expect(readProviderRawAttempt(join(output, "cache"), request.lines[0].key, 1)?.decoded_text).toBe(rawJson);
  await expect(runNavigationProposals(values, output, config, { extract })).rejects.toThrow(/must be new/u);
});
