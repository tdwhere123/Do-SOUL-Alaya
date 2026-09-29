import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { canonicalJson, type SourceDisclosure } from "@do-soul/alaya-protocol";
import { createSemanticProviderHttpExtractor } from "../../../runs/compile-seed/http/semantic-provider-http.js";
import type { CompileSeedExtractionConfig } from "../../../runs/compile-seed/compile-seed-types.js";
import { SOURCE_EVIDENCE_PRESERVATION_SCHEMA_NAME } from "../../../runs/provider-request/request-binding.js";
import { projectGeminiGenerationSchema } from "../../../runs/extraction/fill/batch/generation-schema.js";
import {
  interpretSourceEvidencePreservationDecoded, settleSourceEvidencePreservationDelivery
} from "../../../runs/source-evidence-preservation/assess.js";
import {
  pinSourceEvidencePreservationAuthority, quoteSourceEvidencePreservation
} from "../../../runs/source-evidence-preservation/authority.js";
import {
  executeSourceEvidencePreservationFill, prepareSourceEvidencePreservation,
  readSourceEvidencePreservationResults
} from "../../../runs/source-evidence-preservation/execute.js";
import {
  SOURCE_EVIDENCE_PRESERVATION_SYSTEM_PROMPT, materializeSourceEvidencePreservationLines,
  parseSourceEvidencePreservationWorkset, sourceEvidencePreservationResponseJsonSchema
} from "../../../runs/source-evidence-preservation/input.js";
import {
  inspectSourceEvidencePreservationShard, openSourceEvidencePreservationAttemptLedger,
  sourceEvidencePreservationShardPath
} from "../../../runs/source-evidence-preservation/persist.js";
import {
  evidenceSelectionCacheKey, EVIDENCE_SELECTION_WORKSET_CONTRACT, materializeEvidenceSelectionLines,
  parseEvidenceSelectionWorkset, SOURCE_EVIDENCE_SELECTION_SYSTEM_PROMPT, evidenceSelectionResponseJsonSchema
} from "../../../runs/evidence-selection/input.js";

const MODEL = "gemini-3.1-flash-lite";
const PROFILE = "gemini-3.1-minimal-v1" as const;
const KEEP = "Lee left the lab on Tuesday after the sample arrived.";
const KEEP_QUOTE = "Lee left the lab on Tuesday";
const ARRIVED_QUOTE = "the sample arrived";
const LOST = "The sample was stored at minus twenty.";
const MAYBE = "Someone mentioned a later shipment.";
const ADVICE = "Advice: always label the sample before shipping.";
const DIGEST_KEEP = `sha256:${"a".repeat(64)}`;
const DIGEST_LOST = `sha256:${"b".repeat(64)}`;
const DIGEST_MAYBE = `sha256:${"c".repeat(64)}`;
const DIGEST_ADVICE = `sha256:${"d".repeat(64)}`;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("admits a preserved claim over loopback HTTP and replays reserved raw without a second dispatch or bill", async () => {
  const captured: { hits: number; reservedLedger?: string; urls: string[] } = { hits: 0, urls: [] };
  const server = await listen((req, res) => {
    captured.hits += 1;
    captured.urls.push(req.url ?? "");
    captured.reservedLedger = readFileSync(ledgerPath, "utf8");
    succeed(res, preservedBody(), "STOP", usage());
  });
  const origin = originOf(server);
  const cacheRoot = join(tempRoot(), "cache");
  const prepared = workset(origin);
  prepared.items[0]!.unknown!.query_as_of!.reason = "evaluator_gold_private_label";
  const line = materializeSourceEvidencePreservationLines(prepared, 128)[0]!;
  expect(JSON.parse(line.userPrompt)).toMatchObject({
    question_as_of: { kind: "unknown" }, unknown: { query_as_of: { status: "unknown" } }
  });
  expect(line.userPrompt).not.toContain("evaluator_gold_private_label");
  expect(JSON.parse(line.userPrompt).unknown.query_as_of).toEqual({ status: "unknown" });
  expect(line.userPrompt).not.toMatch(/"event_time"/u);
  expect(SOURCE_EVIDENCE_PRESERVATION_SYSTEM_PROMPT).toMatch(/observation time/u);
  expect(SOURCE_EVIDENCE_PRESERVATION_SYSTEM_PROMPT).not.toMatch(/Lee left|minus twenty/u);
  expect(projectGeminiGenerationSchema(sourceEvidencePreservationResponseJsonSchema()).schema).toBeDefined();
  const preflight = prepareSourceEvidencePreservation(prepared, cacheRoot, 128);
  expect(preflight).toMatchObject({
    contract: "source-evidence-preservation-preflight-v1",
    maximum_attempts_per_key: 1,
    maximum_attempts: 1,
    missing: 1,
    provider_calls: 0
  });
  const estimated = quoteSourceEvidencePreservation(preflight, 4, 18);
  const authority = pinSourceEvidencePreservationAuthority({
    preflight, inputUsdPerMillion: 4, outputUsdPerMillion: 18
  });
  expect(authority.price.estimated_upper_usd).toBe(estimated);
  const ledgerPath = join(cacheRoot, `extraction-attempt-ledger.${authority.attempt_lineage_digest}.json`);
  const config = configOf(origin);
  const first = await executeSourceEvidencePreservationFill({
    workset: prepared, cacheRoot, authority, config,
    extractor: createSemanticProviderHttpExtractor(config, SOURCE_EVIDENCE_PRESERVATION_SCHEMA_NAME)
  });
  const key = authority.keys[0]!;
  const bound = readSourceEvidencePreservationResults(prepared, cacheRoot, 128)[0];
  expect(first).toMatchObject({
    attempts: 1, newly_admitted: 1, preserved: 1, cache_hits: 0, candidate_deliveries: 1
  });
  expect(captured.hits).toBe(1);
  expect(captured.urls[0]).toBe("/v1beta/models/gemini-3.1-flash-lite:streamGenerateContent?alt=sse");
  expect(bound).toMatchObject({
    status: "preserved",
    assessment: {
      status: "preserved",
      records: [
        {
          root_id: "src-keep",
          disposition: "retained",
          identity: { root_id: "src-keep", source_version: "v1", content_digest: DIGEST_KEEP, preview_sha256: sha(KEEP) },
          reference_quotes: [{ quote: KEEP_QUOTE, occurrences: [{ start: 0, end: Buffer.byteLength(KEEP_QUOTE, "utf8") }] }],
          candidate_citations: [{
            root_id: "src-keep",
            identity: { root_id: "src-keep", content_digest: DIGEST_KEEP, preview_sha256: sha(KEEP) },
            quotes: [{ quote: KEEP_QUOTE, occurrences: [{ start: 0, end: Buffer.byteLength(KEEP_QUOTE, "utf8") }] }]
          }]
        },
        { root_id: "src-advice", disposition: "not_relevant" }
      ],
      answer_uncertainties: ["Speaker identity is unknown."]
    },
    delivery: { delivery: "candidate", reason: "preserved", allows_checked_candidate: true }
  });
  const delivery = bound?.delivery;
  if (delivery === undefined) throw new Error("settled preservation must include delivery");
  expect(canonicalJson(delivery.baseline)).toBe(canonicalJson(line.reference_originals));
  const capturedBaseline = canonicalJson(delivery.baseline);
  const originalText = prepared.items[0]!.baseline.items[0]!.text;
  prepared.items[0]!.baseline.items[0]!.text = "mutated after read";
  expect(canonicalJson(delivery.baseline)).toBe(capturedBaseline);
  expect(canonicalJson(line.reference_originals)).toBe(capturedBaseline);
  prepared.items[0]!.baseline.items[0]!.text = originalText;
  expect(openSourceEvidencePreservationAttemptLedger({ cacheRoot, authority }).snapshot().telemetry.totalTokens)
    .toBe(18);
  expect(inspectSourceEvidencePreservationShard(cacheRoot, key, {
    model: MODEL, request_profile: PROFILE
  })?.admitted).toBe(true);

  const settledReplay = await executeSourceEvidencePreservationFill({
    workset: prepared, cacheRoot, authority, config: { ...config, apiKey: null }
  });
  expect(settledReplay).toMatchObject({ cache_hits: 1, newly_admitted: 0, preserved: 1, attempts: 0 });
  expect(captured.hits).toBe(1);
  expect(openSourceEvidencePreservationAttemptLedger({ cacheRoot, authority }).snapshot().telemetry.totalTokens)
    .toBe(18);

  unlinkSync(sourceEvidencePreservationShardPath(cacheRoot, key));
  writeFileSync(ledgerPath, captured.reservedLedger!);
  const rawReplay = await executeSourceEvidencePreservationFill({
    workset: prepared, cacheRoot, authority, config: { ...config, apiKey: null }
  });
  expect(rawReplay).toMatchObject({ newly_admitted: 1, preserved: 1, attempts: 1 });
  expect(captured.hits).toBe(1);
  expect(openSourceEvidencePreservationAttemptLedger({ cacheRoot, authority }).snapshot().telemetry.totalTokens)
    .toBe(18);
  server.closeAllConnections();
  await closeServer(server);
});

it("recovers retained raw without dispatching unknown or never-called keys in a partial window", async () => {
  let hits = 0;
  let reservedLedger = "";
  const server = await listen((_req, res) => {
    hits += 1;
    reservedLedger = readFileSync(ledgerPath, "utf8");
    succeed(res, preservedBody(), "STOP", usage());
  });
  const origin = originOf(server);
  const cacheRoot = join(tempRoot(), "cache");
  const single = workset(origin);
  const prepared = parseSourceEvidencePreservationWorkset({
    ...single,
    items: ["Who left after the sample arrived?", "When did Lee leave?", "What arrived?"].map(question => ({
      ...single.items[0]!, question
    }))
  });
  const authority = pinSourceEvidencePreservationAuthority({
    preflight: prepareSourceEvidencePreservation(prepared, cacheRoot, 128),
    inputUsdPerMillion: 4, outputUsdPerMillion: 18
  });
  const ledgerPath = join(cacheRoot, `extraction-attempt-ledger.${authority.attempt_lineage_digest}.json`);
  const config = configOf(origin);
  const http = createSemanticProviderHttpExtractor(config, SOURCE_EVIDENCE_PRESERVATION_SCHEMA_NAME);
  let extractorCalls = 0;
  const extractor = { ...http, extract: async (input: Parameters<typeof http.extract>[0]) => {
    extractorCalls += 1;
    if (extractorCalls > 1) throw new Error("interrupted after reservation, before transport");
    return http.extract(input);
  } };
  const recover = () => executeSourceEvidencePreservationFill({
    workset: prepared, cacheRoot, authority, mode: "recover",
    config: { ...config, apiKey: null }, extractor
  });
  try {
    await expect(executeSourceEvidencePreservationFill({
      workset: prepared, cacheRoot, authority, config, extractor
    })).rejects.toThrow("interrupted after reservation");
    expect(hits).toBe(1);
    expect(extractorCalls).toBe(2);
    const before = openSourceEvidencePreservationAttemptLedger({ cacheRoot, authority }).snapshot();
    expect(before.attempts).toBe(2);
    const partial = await recover();
    expect(partial).toMatchObject({ attempts: 0, preserved: 1, unknown: 1, unattempted: 1 });
    expect(readSourceEvidencePreservationResults(prepared, cacheRoot, 128).map(row => row.status))
      .toEqual(["preserved", "unknown", "unattempted"]);
    const after = openSourceEvidencePreservationAttemptLedger({ cacheRoot, authority }).snapshot();
    expect(after.attempts).toBe(before.attempts);
    expect(after.unresolvedAttempts).toEqual(before.unresolvedAttempts);
    expect(after.telemetry.totalTokens).toBe(18);

    // Recreate the earlier crash point: first HTTP body persisted, its shard and settlement absent.
    unlinkSync(sourceEvidencePreservationShardPath(cacheRoot, authority.keys[0]!));
    writeFileSync(ledgerPath, reservedLedger);
    expect(await recover()).toMatchObject({ attempts: 0, newly_admitted: 1, preserved: 1, unattempted: 2 });
    const recovered = openSourceEvidencePreservationAttemptLedger({ cacheRoot, authority }).snapshot();
    expect(recovered.attempts).toBe(1);
    expect(recovered.telemetry.totalTokens).toBe(18);
    expect(readSourceEvidencePreservationResults(prepared, cacheRoot, 128).map(row => row.status))
      .toEqual(["preserved", "unattempted", "unattempted"]);
    expect(await recover()).toMatchObject({ attempts: 0, newly_admitted: 0, preserved: 1, unattempted: 2 });
    expect(openSourceEvidencePreservationAttemptLedger({ cacheRoot, authority }).snapshot().telemetry.totalTokens)
      .toBe(18);
    expect(hits).toBe(1);
    expect(extractorCalls).toBe(2);
  } finally {
    server.closeAllConnections();
    await closeServer(server);
  }
});

it("keeps a missing physical response body invalid on cache read instead of marking generation incomplete", async () => {
  let hits = 0;
  const server = await listen((_req, res) => {
    hits += 1;
    succeed(res, preservedBody(), "STOP", usage());
  });
  try {
    const origin = originOf(server);
    const prepared = workset(origin);
    const cacheRoot = join(tempRoot(), "cache");
    const config = configOf(origin);
    const authority = pinSourceEvidencePreservationAuthority({
      preflight: prepareSourceEvidencePreservation(prepared, cacheRoot, 128),
      inputUsdPerMillion: 4, outputUsdPerMillion: 18
    });
    const http = createSemanticProviderHttpExtractor(config, SOURCE_EVIDENCE_PRESERVATION_SCHEMA_NAME);
    await executeSourceEvidencePreservationFill({
      workset: prepared, cacheRoot, authority, config,
      extractor: { ...http, extract: async input => {
        const { responseBody: _omittedBody, ...withoutBody } = await http.extract(input);
        return withoutBody;
      } }
    });
    expect(readSourceEvidencePreservationResults(prepared, cacheRoot, 128)[0]).toMatchObject({
      status: "invalid",
      delivery: { delivery: "baseline", reason: "invalid", invalid_reason: "unusable_response" }
    });
    await executeSourceEvidencePreservationFill({
      workset: prepared, cacheRoot, authority, mode: "recover", config: { ...config, apiKey: null }
    });
    expect(readSourceEvidencePreservationResults(prepared, cacheRoot, 128)[0]?.delivery?.reason).toBe("invalid");
    expect(hits).toBe(1);
    expect(openSourceEvidencePreservationAttemptLedger({ cacheRoot, authority }).snapshot().telemetry.totalTokens).toBe(18);
  } finally {
    server.closeAllConnections();
    await closeServer(server);
  }
});

it("keeps malformed, abstain, incomplete, and incoherent status distinct without admitting candidate delivery", async () => {
  const cases = [
    { label: "malformed", body: "{", finish: "STOP", status: "invalid", rejected: 1, incomplete: 0, abstained: 0 },
    {
      label: "abstain",
      body: { status: "cannot_assess", records: [], answer_uncertainties: ["Candidate set is empty."] },
      finish: "STOP", status: "abstained", rejected: 0, incomplete: 0, abstained: 1
    },
    { label: "incomplete", body: preservedBody(), finish: "MAX_TOKENS", status: "incomplete", rejected: 0, incomplete: 1, abstained: 0 },
    {
      label: "incoherent preserved with loss",
      body: {
        status: "preserved",
        records: [
          retained("src-keep"),
          { root_id: "src-advice", disposition: "loss", reason: "Missing storage temperature." }
        ],
        answer_uncertainties: []
      },
      finish: "STOP", status: "invalid", rejected: 1, incomplete: 0, abstained: 0
    }
  ] as const;
  for (const fixture of cases) {
    const captured = { hits: 0 };
    const server = await listen((_req, res) => {
      captured.hits += 1;
      succeed(res, fixture.body, fixture.finish, usage());
    });
    try {
      const origin = originOf(server);
      const cacheRoot = join(tempRoot(), "cache");
      const prepared = workset(origin);
      const authority = pinSourceEvidencePreservationAuthority({
        preflight: prepareSourceEvidencePreservation(prepared, cacheRoot, 128),
        inputUsdPerMillion: 4, outputUsdPerMillion: 18
      });
      const config = configOf(origin);
      const result = await executeSourceEvidencePreservationFill({
        workset: prepared, cacheRoot, authority, config,
        extractor: createSemanticProviderHttpExtractor(config, SOURCE_EVIDENCE_PRESERVATION_SCHEMA_NAME)
      });
      expect(result, fixture.label).toMatchObject({
        attempts: 1, newly_admitted: 0, preserved: 0, candidate_deliveries: 0,
        rejected: fixture.rejected, incomplete: fixture.incomplete, abstained: fixture.abstained
      });
      expect(captured.hits).toBe(1);
      const row = readSourceEvidencePreservationResults(prepared, cacheRoot, 128)[0];
      expect(row, fixture.label).toMatchObject({
        status: fixture.status,
        delivery: { delivery: "baseline", allows_checked_candidate: false }
      });
      const delivery = row?.delivery;
      if (delivery === undefined) throw new Error("settled failure must include baseline delivery");
      expect(canonicalJson(delivery.baseline))
        .toBe(canonicalJson(lineOf(prepared).reference_originals));
    } finally {
      server.closeAllConnections();
      await closeServer(server);
    }
  }
});

it("binds every reference disposition and citation, and falls back for lost, unresolved, and invalid claims", () => {
  const prepared = workset("http://127.0.0.1:9", fourReferences());
  const line = materializeSourceEvidencePreservationLines(prepared, 128)[0]!;
  const all = interpret(line, {
    status: "unresolved",
    records: [
      retained("src-keep"),
      { root_id: "src-lost", disposition: "loss", reason: "Temperature is absent from the candidates." },
      { root_id: "src-maybe", disposition: "material_comparison_unknown", reason: "Shipment time is not in either preview." },
      { root_id: "src-advice", disposition: "not_relevant", reason: "Advice is not an occurrence report." }
    ],
    answer_uncertainties: ["Who mentioned the shipment is unknown."]
  });
  expect(all).toMatchObject({ classified: "interpreted", admitted: true, outcome: { status: "unresolved" } });
  if (all.outcome.status !== "unresolved") throw new Error("expected unresolved");
  expect(all.outcome.records.map((record) => [record.root_id, record.disposition])).toEqual([
    ["src-keep", "retained"], ["src-lost", "loss"], ["src-maybe", "material_comparison_unknown"], ["src-advice", "not_relevant"]
  ]);
  expect(all.outcome.records[0]).toMatchObject({
    reference_quotes: [{ quote: KEEP_QUOTE, occurrences: [{ start: 0, end: KEEP_QUOTE.length }] }],
    identity: { content_digest: DIGEST_KEEP, span: { content_start: 0, content_end: KEEP.length } },
    candidate_citations: [{ root_id: "src-keep", identity: { content_digest: DIGEST_KEEP } }]
  });
  expect(settleSourceEvidencePreservationDelivery({
    references: line.reference_originals, candidates: line.candidate_originals, outcome: all.outcome
  })).toMatchObject({ delivery: "baseline", reason: "unresolved", allows_checked_candidate: false });

  const lost = interpret(line, {
    status: "lost",
    records: [
      { root_id: "src-keep", disposition: "loss", reason: "Departure is missing." },
      { root_id: "src-lost", disposition: "loss", reason: "Temperature is missing." },
      { root_id: "src-maybe", disposition: "not_relevant", reason: "Not required." },
      { root_id: "src-advice", disposition: "not_relevant", reason: "Advice." }
    ],
    answer_uncertainties: []
  });
  expect(lost.outcome.status).toBe("lost");
  expect(settleSourceEvidencePreservationDelivery({
    references: line.reference_originals, candidates: line.candidate_originals, outcome: lost.outcome
  })).toMatchObject({ delivery: "baseline", reason: "loss" });

  expect(interpret(line, {
    status: "preserved",
    records: [
      { root_id: "missing-root", disposition: "not_relevant", reason: "Foreign." },
      retained("src-keep"),
      { root_id: "src-lost", disposition: "not_relevant", reason: "x" },
      { root_id: "src-maybe", disposition: "not_relevant", reason: "y" }
    ],
    answer_uncertainties: []
  }).outcome).toMatchObject({ status: "invalid", reason: "unknown_root" });
  expect(interpret(line, {
    status: "preserved",
    records: [retained("src-keep"), retained("src-keep"),
      { root_id: "src-lost", disposition: "not_relevant", reason: "x" },
      { root_id: "src-maybe", disposition: "not_relevant", reason: "y" }],
    answer_uncertainties: []
  }).outcome).toMatchObject({ status: "invalid", reason: "duplicate_root" });
  expect(interpret(line, {
    status: "preserved", records: [retained("src-keep")], answer_uncertainties: []
  }).outcome).toMatchObject({ status: "invalid", reason: "omitted_root" });
  expect(interpret(line, {
    status: "preserved",
    records: [
      { ...retained("src-keep"), reference_quotes: ["Lee never left"] },
      { root_id: "src-lost", disposition: "not_relevant", reason: "x" },
      { root_id: "src-maybe", disposition: "not_relevant", reason: "y" },
      { root_id: "src-advice", disposition: "not_relevant", reason: "z" }
    ],
    answer_uncertainties: []
  }).outcome).toMatchObject({ status: "invalid", reason: "quote_mismatch" });

  const unavailable = settleSourceEvidencePreservationDelivery({
    references: line.reference_originals, candidates: line.candidate_originals,
    outcome: { status: "transport_failure" }
  });
  expect(unavailable).toMatchObject({ delivery: "baseline", reason: "unavailable", allows_checked_candidate: false });
  expect(canonicalJson(unavailable.baseline)).toBe(canonicalJson(line.reference_originals));
});

it("allows preserved identical unknown records with separate answer uncertainties and does not invent a question clock", () => {
  const prepared = parseSourceEvidencePreservationWorkset({
    contract: "source-evidence-preservation-workset-v1",
    model: MODEL, provider_url: "http://127.0.0.1:9", request_profile: PROFILE,
    items: [{
      question: "Who left after the sample arrived?",
      unknown: { query_as_of: { status: "unknown" } },
      baseline: { items: [original("src-keep", DIGEST_KEEP, KEEP, { kind: "unknown", reason: "not_recorded" })] },
      candidate: { items: [original("src-keep", DIGEST_KEEP, KEEP, { kind: "unknown", reason: "not_recorded" })] }
    }]
  });
  const line = materializeSourceEvidencePreservationLines(prepared, 128)[0]!;
  const prompt = JSON.parse(line.userPrompt) as {
    question_as_of: unknown;
    reference_originals: Array<{ source_disclosure: SourceDisclosure }>;
  };
  expect(prompt.question_as_of).toEqual({ kind: "unknown" });
  expect(prompt.reference_originals[0]?.source_disclosure.source_time).toEqual({ kind: "unknown", reason: "not_recorded" });
  expect(line.userPrompt).not.toMatch(/c01|question_as_of":\{"kind":"known"/u);
  expect(line.userPrompt).not.toMatch(/"event_time"/u);
  const interpreted = interpret(line, {
    status: "preserved",
    records: [retained("src-keep")],
    answer_uncertainties: ["The observation time is unknown, so the answer remains incomplete."]
  });
  expect(interpreted).toMatchObject({ classified: "interpreted", admitted: true, outcome: { status: "preserved" } });
  expect(settleSourceEvidencePreservationDelivery({
    references: line.reference_originals, candidates: line.candidate_originals, outcome: interpreted.outcome
  })).toMatchObject({ delivery: "candidate", reason: "preserved", allows_checked_candidate: true });
  expect(() => parseSourceEvidencePreservationWorkset({
    ...prepared, items: [{ ...prepared.items[0], unknown: { query_as_of: { status: "known" } } }]
  })).toThrow();
});

it("rejects retained claims that only quote the reference or name a foreign candidate", () => {
  const line = materializeSourceEvidencePreservationLines(workset("http://127.0.0.1:9"), 128)[0]!;
  expect(interpret(line, {
    status: "preserved",
    records: [
      {
        root_id: "src-keep", disposition: "retained",
        reference_quotes: [KEEP_QUOTE]
      },
      { root_id: "src-advice", disposition: "not_relevant", reason: "Advice." }
    ],
    answer_uncertainties: []
  }).outcome).toMatchObject({ status: "invalid", reason: "invalid_shape" });
  expect(interpret(line, {
    status: "preserved",
    records: [
      {
        ...retained("src-keep"),
        candidate_citations: [{ root_id: "missing-cand", quotes: [KEEP_QUOTE] }]
      },
      { root_id: "src-advice", disposition: "not_relevant", reason: "Advice." }
    ],
    answer_uncertainties: []
  }).outcome).toMatchObject({ status: "invalid", reason: "unknown_root" });
});

it("binds joint retention across explicit candidate roots and keeps fallback unchanged", () => {
  const extra = "Lee left the lab on Tuesday. Later notes mention the sample arrived.";
  const prepared = parseSourceEvidencePreservationWorkset({
    contract: "source-evidence-preservation-workset-v1",
    model: MODEL, provider_url: "http://127.0.0.1:9", request_profile: PROFILE,
    items: [{
      question: "Who left after the sample arrived?",
      unknown: { query_as_of: { status: "unknown" } },
      baseline: { items: [original("src-keep", DIGEST_KEEP, KEEP, { kind: "known", at: "2024-05-01T12:00:00.000Z" })] },
      candidate: { items: [
        original("src-keep", DIGEST_KEEP, KEEP, { kind: "known", at: "2024-05-01T12:00:00.000Z" }),
        original("src-extra", DIGEST_LOST, extra, { kind: "known", at: "2024-05-03T12:00:00.000Z" })
      ] }
    }]
  });
  const line = materializeSourceEvidencePreservationLines(prepared, 128)[0]!;
  const interpreted = interpret(line, {
    status: "preserved",
    records: [{
      root_id: "src-keep", disposition: "retained",
      reference_quotes: [KEEP_QUOTE],
      candidate_citations: [
        { root_id: "src-keep", quotes: [KEEP_QUOTE] },
        { root_id: "src-extra", quotes: [ARRIVED_QUOTE] }
      ]
    }],
    answer_uncertainties: ["Speaker identity is unknown."]
  });
  expect(interpreted).toMatchObject({ classified: "interpreted", admitted: true, outcome: { status: "preserved" } });
  if (interpreted.outcome.status !== "preserved") throw new Error("expected preserved");
  expect(interpreted.outcome.records[0]).toMatchObject({
    candidate_citations: [
      { root_id: "src-keep", identity: { content_digest: DIGEST_KEEP } },
      { root_id: "src-extra", identity: { content_digest: DIGEST_LOST } }
    ]
  });
  const invalid = settleSourceEvidencePreservationDelivery({
    references: line.reference_originals, candidates: line.candidate_originals,
    outcome: { status: "invalid", reason: "invalid_shape" }
  });
  const unavailable = settleSourceEvidencePreservationDelivery({
    references: line.reference_originals, candidates: line.candidate_originals,
    outcome: { status: "transport_failure" }
  });
  const before = canonicalJson(line.reference_originals);
  prepared.items[0]!.baseline.items[0]!.text = "mutated input";
  expect(canonicalJson(invalid.baseline)).toBe(before);
  expect(canonicalJson(unavailable.baseline)).toBe(before);
  expect(invalid).toMatchObject({ delivery: "baseline", reason: "invalid", allows_checked_candidate: false });
  expect(unavailable).toMatchObject({ delivery: "baseline", reason: "unavailable", allows_checked_candidate: false });
});

it("keeps historical selection request keys unchanged beside the preservation schema", () => {
  const origin = "http://127.0.0.1:9";
  const selected = parseEvidenceSelectionWorkset({
    contract: EVIDENCE_SELECTION_WORKSET_CONTRACT, model: MODEL, provider_url: origin, request_profile: PROFILE,
    items: [{
      original_question: "Who left after the sample arrived?",
      sources: [
        { root_id: "src-keep", version: "v1", digest: DIGEST_KEEP, span: { start: 0, end: KEEP.length }, preview: KEEP },
        { root_id: "src-advice", version: "v1", digest: DIGEST_ADVICE, span: { start: 0, end: ADVICE.length }, preview: ADVICE }
      ]
    }]
  });
  const selection = materializeEvidenceSelectionLines(selected, 128)[0]!;
  expect(evidenceSelectionCacheKey({
    model: MODEL, requestProfile: PROFILE, systemPrompt: SOURCE_EVIDENCE_SELECTION_SYSTEM_PROMPT,
    userPrompt: selection.userPrompt, schema: evidenceSelectionResponseJsonSchema(),
    maxOutputTokens: 128, providerUrl: selected.provider_url
  })).toBe(selection.key);
  const preserved = materializeSourceEvidencePreservationLines(workset(origin), 128)[0]!;
  expect(preserved.key).not.toBe(selection.key);
  expect(preserved.requestDigest).not.toBe(selection.requestDigest);
});

it("binds UTF-8 quote offsets from span.content_start and rejects same-root identity drift", () => {
  const text = "前汉后汉";
  const quote = "汉";
  const start = 8;
  const han = Buffer.byteLength(quote, "utf8");
  const first = start + Buffer.byteLength("前", "utf8");
  const second = first + han + Buffer.byteLength("后", "utf8");
  const prepared = parseSourceEvidencePreservationWorkset({
    contract: "source-evidence-preservation-workset-v1",
    model: MODEL, provider_url: "http://127.0.0.1:9", request_profile: PROFILE,
    items: [{
      question: "Who left after the sample arrived?",
      unknown: { query_as_of: { status: "unknown" } },
      baseline: { items: [original("src-han", DIGEST_KEEP, text, { kind: "known", at: "2024-05-01T12:00:00.000Z" }, start)] },
      candidate: { items: [original("src-han", DIGEST_KEEP, text, { kind: "known", at: "2024-05-01T12:00:00.000Z" }, start)] }
    }]
  });
  const line = materializeSourceEvidencePreservationLines(prepared, 128)[0]!;
  const interpreted = interpret(line, {
    status: "preserved",
    records: [{
      root_id: "src-han", disposition: "retained",
      reference_quotes: [quote],
      candidate_citations: [{ root_id: "src-han", quotes: [quote] }]
    }],
    answer_uncertainties: ["Speaker identity is unknown."]
  });
  expect(interpreted.outcome).toMatchObject({
    status: "preserved",
    records: [{
      reference_quotes: [{ quote, occurrences: [{ start: first, end: first + han }, { start: second, end: second + han }] }],
      candidate_citations: [{ quotes: [{ occurrences: [{ start: first }, { start: second }] }] }]
    }]
  });
  expect(() => parseSourceEvidencePreservationWorkset({
    contract: "source-evidence-preservation-workset-v1",
    model: MODEL, provider_url: "http://127.0.0.1:9", request_profile: PROFILE,
    items: [{
      question: "Who left after the sample arrived?",
      baseline: { items: [original("src-keep", DIGEST_KEEP, KEEP, { kind: "known", at: "2024-05-01T12:00:00.000Z" })] },
      candidate: { items: [original("src-keep", DIGEST_KEEP, `${KEEP} extra`, { kind: "known", at: "2024-05-01T12:00:00.000Z" })] }
    }]
  })).toThrow(/identity disagrees/u);
});

it("reads HTTP transport failure as unavailable baseline and leaves unattempted distinct", async () => {
  const unattemptedRoot = join(tempRoot(), "cache-unattempted");
  const idle = workset("http://127.0.0.1:9");
  expect(readSourceEvidencePreservationResults(idle, unattemptedRoot, 128)[0]).toMatchObject({
    status: "unattempted"
  });
  expect(readSourceEvidencePreservationResults(idle, unattemptedRoot, 128)[0]?.delivery).toBeUndefined();
  const server = await listen((_req, res) => {
    res.statusCode = 500;
    res.end("provider unavailable");
  });
  try {
    const origin = originOf(server);
    const cacheRoot = join(tempRoot(), "cache-fail");
    const prepared = workset(origin);
    const authority = pinSourceEvidencePreservationAuthority({
      preflight: prepareSourceEvidencePreservation(prepared, cacheRoot, 128),
      inputUsdPerMillion: 4, outputUsdPerMillion: 18
    });
    const config = configOf(origin);
    const result = await executeSourceEvidencePreservationFill({
      workset: prepared, cacheRoot, authority, config,
      extractor: createSemanticProviderHttpExtractor(config, SOURCE_EVIDENCE_PRESERVATION_SCHEMA_NAME)
    });
    expect(result).toMatchObject({ attempts: 1, newly_admitted: 0, candidate_deliveries: 0 });
    const row = readSourceEvidencePreservationResults(prepared, cacheRoot, 128)[0];
    expect(row).toMatchObject({
      status: "transport_failure",
      delivery: { delivery: "baseline", reason: "unavailable", allows_checked_candidate: false }
    });
    const delivery = row?.delivery;
    if (delivery === undefined) throw new Error("transport failure must keep baseline delivery");
    expect(canonicalJson(delivery.baseline)).toBe(canonicalJson(lineOf(prepared).reference_originals));
  } finally {
    server.closeAllConnections();
    await closeServer(server);
  }
});

function interpret(
  line: ReturnType<typeof materializeSourceEvidencePreservationLines>[number], body: unknown
) {
  return interpretSourceEvidencePreservationDecoded(line, {
    rawJson: typeof body === "string" ? body : JSON.stringify(body), finishReason: "STOP"
  }, PROFILE);
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "evidence-preservation-"));
  roots.push(root);
  return root;
}

function workset(providerUrl: string, item?: ReturnType<typeof fourReferences>) {
  return parseSourceEvidencePreservationWorkset({
    contract: "source-evidence-preservation-workset-v1",
    model: MODEL, provider_url: providerUrl, request_profile: PROFILE,
    items: [item ?? {
      question: "Who left after the sample arrived?",
      unknown: { query_as_of: { status: "unknown" as const } },
      baseline: { items: [
        original("src-keep", DIGEST_KEEP, KEEP, { kind: "known", at: "2024-05-01T12:00:00.000Z" }),
        original("src-advice", DIGEST_ADVICE, ADVICE, { kind: "known", at: "2024-05-02T12:00:00.000Z" })
      ] },
      candidate: { items: [original("src-keep", DIGEST_KEEP, KEEP, { kind: "known", at: "2024-05-01T12:00:00.000Z" })] }
    }]
  });
}

function fourReferences() {
  return {
    question: "Who left after the sample arrived?",
    unknown: { query_as_of: { status: "unknown" as const } },
    baseline: { items: [
      original("src-keep", DIGEST_KEEP, KEEP, { kind: "known", at: "2024-05-01T12:00:00.000Z" }),
      original("src-lost", DIGEST_LOST, LOST, { kind: "known", at: "2024-05-01T13:00:00.000Z" }),
      original("src-maybe", DIGEST_MAYBE, MAYBE, { kind: "unknown", reason: "not_recorded" as const }),
      original("src-advice", DIGEST_ADVICE, ADVICE, { kind: "known", at: "2024-05-02T12:00:00.000Z" })
    ] },
    candidate: { items: [original("src-keep", DIGEST_KEEP, KEEP, { kind: "known", at: "2024-05-01T12:00:00.000Z" })] }
  };
}

function sha(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function original(
  root_id: string, content_digest: string, text: string, source_time: SourceDisclosure["source_time"],
  content_start = 0
) {
  const bytes = Buffer.byteLength(text, "utf8");
  return {
    root_id,
    source_version: "v1",
    content_digest,
    span: {
      content_start,
      content_end: content_start + bytes,
      retained_extent: "body" as const,
      content_complete: content_start === 0,
      original_complete: false
    },
    preview_sha256: sha(text),
    source_disclosure: disclosure(source_time),
    text
  };
}

function disclosure(source_time: SourceDisclosure["source_time"]): SourceDisclosure {
  return {
    material_kind: "original_body",
    source_binding: "checked_record",
    evaluated_as_of: "2024-06-01T00:00:00.000Z",
    source_time,
    validity: { kind: "unknown", reason: "not_recorded" },
    temporal_state: "unknown",
    proof_use: { kind: "source_only", qualification: "not_current_proof" }
  };
}

function configOf(origin: string): CompileSeedExtractionConfig {
  return { providerUrl: origin, model: MODEL, requestProfile: PROFILE, apiKey: "loopback-only" };
}

function usage() {
  return { inputTokens: 11, outputTokens: 7, totalTokens: 18 };
}

function lineOf(prepared: ReturnType<typeof parseSourceEvidencePreservationWorkset>) {
  return materializeSourceEvidencePreservationLines(prepared, 128)[0]!;
}

function retained(root_id: string) {
  return {
    root_id,
    disposition: "retained" as const,
    reference_quotes: [KEEP_QUOTE],
    candidate_citations: [{ root_id, quotes: [KEEP_QUOTE] }]
  };
}

function preservedBody() {
  return {
    status: "preserved" as const,
    records: [retained("src-keep"), { root_id: "src-advice", disposition: "not_relevant" as const, reason: "Advice." }],
    answer_uncertainties: ["Speaker identity is unknown."]
  };
}

function succeed(
  res: import("node:http").ServerResponse,
  body: unknown,
  finishReason: string,
  tokens: { inputTokens: number; outputTokens: number; totalTokens: number }
): void {
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({
    candidates: [{
      finishReason,
      content: { parts: [{ text: typeof body === "string" ? body : JSON.stringify(body) }] }
    }],
    usageMetadata: {
      promptTokenCount: tokens.inputTokens,
      candidatesTokenCount: tokens.outputTokens,
      totalTokenCount: tokens.totalTokens
    }
  }));
}

async function listen(handler: import("node:http").RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  return server;
}

function originOf(server: import("node:http").Server): string {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("loopback server has no port");
  return `http://127.0.0.1:${(address as AddressInfo).port}`;
}

function closeServer(server: import("node:http").Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
