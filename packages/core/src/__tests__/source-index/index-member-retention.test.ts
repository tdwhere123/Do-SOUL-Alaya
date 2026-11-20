import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../scripts/test-support/provider-free/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); });
afterAll(() => isolation.restore());
import { prepareSourceIndexDocument, sourceIndexProfileId, type SourceIndexAcquisitionInput, type SourceIndexLexicalRead,
  type SourceIndexQueryRepository, type SourceIndexVectorRead } from "@do-soul/alaya-protocol";
import { SourceIndexAcquisition } from "../../source-index/source-index-acquisition.js";
import type { SourceIndexAcquisitionFact } from "../../source-index/acquisition-observation.js";
import { SqliteSourceIndexRepository } from "../../../../storage/src/repos/source-index/source-index-repo.js";
import { WORKSPACE, configuration, fieldSha256, fixture as sqliteFixture, publishSource } from
  "../../../../storage/src/__tests__/repos/source-index/source-index-fixture.js";
import { publishMessages, publishStatement } from "../../../../storage/src/__tests__/repos/source-index/source-template-fixture.js";
import { digest } from "./source-index-acquisition-fixture.js";
import { template, templateBudget, templateStatement } from "./source-template-fixture.js";

const empty = { work: 0, memory_bytes: 0, native_bytes: 0, sql_internal_work: "unknown" as const };

type Row = ReturnType<typeof templateStatement>;
function lexical(rows: readonly Row[]): SourceIndexLexicalRead {
  return { completion: "complete", reason: null,
    candidates: rows.map((row, i) => ({ source: row.source, lexical: { lane: "unicode61", rank: i + 1, lane_rank: i + 1, bm25: -1 } })),
    resources: empty, resource_refusal: null, index_coverage: "partial", limitations: [], tokenization: null };
}

function fixture(rows: readonly Row[]) {
  const repository: SourceIndexQueryRepository = {
    readLexicalCandidates: () => lexical(rows),
    readVectorCandidates: () => ({ completion: "complete", reason: null, candidates: [], resources: empty,
      state: { status: "unavailable", reason: "fixture" }, resource_refusal: null, cursor: null, inspected: 0, invalid: 0 }),
    admitQueryCandidate: () => ({ status: "ready", scope_class: "project", resources: empty })
  };
  const input: SourceIndexAcquisitionInput = { workspace_id: "workspace-template", navigation_text: "game",
    vector: { status: "unavailable", reason: "fixture" }, allowance: { max_attempts: 128, max_roots: 16, max_vector_windows: 0 },
    budget: templateBudget };
  return { repository, input, run: (members: number, view: "original" | "hint" = "original") =>
    new SourceIndexAcquisition(repository, fieldSha256)
      .nominateWithWitness(input, () => "admitted", view, undefined, undefined, undefined, undefined, members) };
}

it("lists roots refused only by the root limit, in attempt order, without changing the nominated prefix or its resources", () => {
  const rows = Array.from({ length: 24 }, (_, i) => templateStatement(`root-${i}`));
  const { run } = fixture(rows);
  const base = run(0), listed = run(16);
  expect(base).not.toHaveProperty("index_members");
  expect(listed.result.nominations).toEqual(base.result.nominations);
  expect(listed.result.accounting).toEqual(base.result.accounting);
  expect(listed.result.resources).toEqual(base.result.resources);
  expect(listed.result.completion).toBe(base.result.completion);
  expect(listed.index_members).toEqual(rows.slice(16).map(row => row.source));
});

it("caps the list, skips repeated roots and lists nothing for the hint view", () => {
  const rows = Array.from({ length: 24 }, (_, i) => templateStatement(`root-${i}`));
  const { run } = fixture([...rows, rows[20]!, rows[3]!]);
  expect(run(3).index_members).toEqual(rows.slice(16, 19).map(row => row.source));
  expect(run(16).index_members).toEqual(rows.slice(16).map(row => row.source));
  expect(run(16, "hint")).not.toHaveProperty("index_members");
});

it.each([
  { maxAttempts: 128, extraTail: 5, tailOverBudget: false },
  { maxAttempts: 27, extraTail: 0, tailOverBudget: false },
  { maxAttempts: 128, extraTail: 0, tailOverBudget: true }
])("lists displaced originals before the unrestricted tail (attempts=$maxAttempts, listing exhausted=$tailOverBudget)",
  ({ maxAttempts, extraTail, tailOverBudget }) => {
    const original = Array.from({ length: 24 }, (_, i) => templateStatement(`original-${i}`));
    const preferred = Array.from({ length: 16 }, (_, i) => templateStatement(`preferred-${i}`));
    const base = fixture(original);
    const admit = vi.fn<SourceIndexQueryRepository["admitQueryCandidate"]>(source => ({
      status: "ready", scope_class: "project",
      resources: tailOverBudget && source === original[16]!.source ? { ...empty, work: 524_288 } : empty
    }));
    const repository: SourceIndexQueryRepository = {
      ...base.repository,
      readLexicalCandidates: (_workspace, _query, limit, _budget, time) => lexical((time ? preferred : original).slice(0, limit)),
      readQuestionTimeDomain: () => ({ status: "ready", exists: true, matched_root_keys: [], resources: empty }),
      readTemplateStatements: source => source === original[0]!.source ? original[0]!.read
        : { status: "complete", statements: [], resources: empty },
      admitQueryCandidate: admit
    };
    const run = (count: number) => {
      const observed: SourceIndexAcquisitionFact[] = [];
      const capture = new SourceIndexAcquisition(repository, fieldSha256).nominateWithWitness({
        ...base.input, allowance: { ...base.input.allowance, max_attempts: maxAttempts }, source_template: template,
        question_time: { interpretation_clock: template.interpretation_clock,
          intervals: [{ start: "2026-09-01", end: "2026-09-06" }] }
      }, () => "admitted", "original", fact => { observed.push(fact()); },
      { status: "ready", vectors: [Float32Array.of(1)], conditions: [{ statement: "s", speaker: "user", anchors: [] }] },
      { retain: (result, meter) => {
        const before = meter.spentBytes;
        meter.retain(result);
        return meter.spentBytes - before;
      } }, undefined, count);
      return { capture, observed };
    };
    const unlisted = run(0);
    expect(admit).toHaveBeenCalledTimes(27);
    admit.mockClear();
    const listed = run(16);
    const { index_members, ...ranked } = listed.capture;
    expect(ranked).toEqual(unlisted.capture);
    expect(listed.observed).toEqual(unlisted.observed);
    expect(ranked.result.nominations.map(row => row.source)).toEqual([
      original[0]!.source, ...preferred.slice(0, 11).map(row => row.source), ...original.slice(1, 5).map(row => row.source)
    ]);
    expect(index_members).toEqual(original.slice(5, 16 + extraTail).map(row => row.source));
    expect(admit.mock.calls.slice(27).map(([source]) => source)).toEqual(tailOverBudget
      ? [original[16]!.source] : original.slice(16, 16 + extraTail).map(row => row.source));
  });

it("surfaces a raw passage winner diluted by statement vectors via 3-way SQLite overflow without altering R01..R16", () => {
  const environment = sqliteFixture();
  const { database, index } = environment;
  try {
    for (let i = 0; i < 20; i++) {
      publishSource(environment, `needle lexical passage ${i}`, `lex-${i.toString().padStart(2, "0")}`);
    }
    for (let i = 0; i < 18; i++) {
      const published = publishMessages(environment, [{ role: "user", text: `statement host ${i}` }],
        `stmt-${i.toString().padStart(2, "0")}`);
      publishStatement(environment, published, `stmt-art-${i}`);
    }
    publishSource(environment, "raw top passage", "raw-top");
    publishSource(environment, "raw diluted passage", "raw-winner");

    const config = configuration({ dimensions: 3, window_bytes: 512 });
    const selection = index.select(WORKSPACE, config), generation = index.begin(selection);
    const writeBudget = { work: 100_000, native_bytes: 16 * 1024 * 1024 };
    expect(index.capturePage(WORKSPACE, generation.generation_id, 128, writeBudget).generation.enumeration_complete).toBe(true);
    const documents = index.listTargets(WORKSPACE, generation.generation_id, null, 128).map(source => {
      const read = index.readDocument(WORKSPACE, generation.generation_id, source.root_key, 4 * 1024 * 1024, writeBudget);
      expect(read.status).toBe("ready");
      if (read.status !== "ready") throw new Error(read.reason);
      const document = prepareSourceIndexDocument({ source, body: read.body, profile: config.profile }, fieldSha256);
      expect(index.writeDocument(WORKSPACE, generation.generation_id, document, writeBudget).status).toBe("accepted");
      return document;
    });
    const unit = (cos: number) => new Float32Array([cos, Math.sqrt(Math.max(0, 1 - cos * cos)), 0]);
    database.connection.transaction(() => {
      for (const document of documents) {
        const id = document.source.source_id!;
        let cos = 0;
        if (id === "raw-top") cos = 0.99;
        else if (id === "raw-winner") cos = 0.80;
        else if (id.startsWith("stmt-")) {
          const rank = Number(id.slice(5));
          cos = document.source.auxiliary === undefined ? 0.10 : 0.98 - rank * 0.008;
        }
        const embedding = unit(cos);
        for (const window of document.windows) {
          expect(index.writeVector(WORKSPACE, generation.generation_id, {
            window_id: window.window_id, input_digest: window.content_digest,
            embedding, token_count: 2, truncated: false
          })).toEqual({ status: "accepted" });
        }
      }
    })();
    expect(index.activate(WORKSPACE, generation.generation_id)).toEqual({ status: "accepted" });

    const repo = new SqliteSourceIndexRepository(database, fieldSha256);
    const admit = vi.spyOn(repo, "admitQueryCandidate");
    const input: SourceIndexAcquisitionInput = {
      workspace_id: WORKSPACE, navigation_text: "needle",
      allowance: { max_attempts: 128, max_roots: 16, max_vector_windows: 256 },
      budget: { work_units: 5_000_000, memory_bytes: 32 * 1024 * 1024 },
      vector: {
        status: "available", profile: config.profile, profile_id: selection.profile_id,
        input_digest: digest("needle"), embedding: new Float32Array([1, 0, 0])
      }
    };
    const run = (members: number) => {
      const observed: SourceIndexAcquisitionFact[] = [];
      const capture = database.connection.transaction(() => new SourceIndexAcquisition(repo, fieldSha256)
        .nominateWithWitness(input, () => "admitted", "original", fact => { observed.push(fact()); },
          undefined, undefined, undefined, members))();
      return { capture, observed };
    };

    const base = run(0);
    admit.mockClear();
    const listed = run(16);
    expect(admit.mock.calls.length).toBeGreaterThan(0);

    const { index_members, ...ranked } = listed.capture;
    expect(ranked.result.nominations).toEqual(base.capture.result.nominations);
    expect(ranked.result.accounting).toEqual(base.capture.result.accounting);
    expect(ranked.result.resources).toEqual(base.capture.result.resources);
    expect(ranked.witness).toEqual(base.capture.witness);
    expect(listed.observed).toEqual(base.observed);
    expect(ranked.result.nominations.map(row => row.source.source_id)).toContain("raw-top");
    expect(ranked.result.nominations.map(row => row.source.source_id)).not.toContain("raw-winner");
    expect(index_members).toHaveLength(16);
    expect(index_members![1]!.source_id).toBe("raw-winner");
  } finally {
    database.close({ optimize: false });
  }
}, 60_000);

it("surfaces an unvisited raw passage winner when max_attempts stops nominatePrefix before its mixed vector rank", () => {
  const lexicalRows = Array.from({ length: 16 }, (_, i) => templateStatement(`lex-${i}`));
  const stmtRows = Array.from({ length: 27 }, (_, i) => templateStatement(`stmt-${i}`));
  const rawTop = templateStatement("raw-top");
  const rawUnvisited = templateStatement("raw-unvisited-winner");
  const config = configuration({ dimensions: 2, window_bytes: 8 });
  const profileId = sourceIndexProfileId(config.profile, fieldSha256);
  const binding = {
    workspace_id: "workspace-template", selection_revision: 1, config_id: "cfg-1",
    profile_id: profileId, generation_id: "gen-unvisited", source_epoch: 1, dimensions: 2
  };
  const candidates: SourceIndexVectorRead["candidates"] = [
    {
      source: rawTop.source,
      window: { window_id: "wr-top", start_byte: 0, end_byte: 8, content_digest: `sha256:${"c".repeat(64)}` },
      embedding: Float32Array.of(0.99, 0.01)
    },
    ...stmtRows.map((row, i) => ({
      source: row.statement.source,
      window: { window_id: `ws-${i}`, start_byte: 0, end_byte: 8, content_digest: `sha256:${"a".repeat(64)}` },
      embedding: Float32Array.of(0.98 - i * 0.005, 0.05)
    })),
    {
      source: rawUnvisited.source,
      window: { window_id: "wr-unvisited", start_byte: 0, end_byte: 8, content_digest: `sha256:${"b".repeat(64)}` },
      embedding: Float32Array.of(0.80, 0.05)
    }
  ];
  const admit = vi.fn<SourceIndexQueryRepository["admitQueryCandidate"]>(() => ({
    status: "ready", scope_class: "project", resources: empty
  }));
  const repository: SourceIndexQueryRepository = {
    readLexicalCandidates: (_workspace, _query, limit) => lexical(lexicalRows.slice(0, limit)),
    readVectorCandidates: () => ({
      completion: "complete", reason: null, candidates, resources: empty,
      state: { status: "ready", binding }, resource_refusal: null, cursor: null,
      inspected: candidates.length, invalid: 0
    }),
    admitQueryCandidate: admit
  };
  const input: SourceIndexAcquisitionInput = {
    workspace_id: "workspace-template", navigation_text: "game",
    allowance: { max_attempts: 32, max_roots: 16, max_vector_windows: 64 },
    budget: templateBudget,
    vector: {
      status: "available", profile: config.profile, profile_id: profileId,
      input_digest: digest("game"), embedding: Float32Array.of(1, 0)
    }
  };
  const run = (members: number) => new SourceIndexAcquisition(repository, fieldSha256)
    .nominateWithWitness(input, () => "admitted", "original", undefined, undefined, undefined, undefined, members);

  const base = run(0);
  expect(base.result.accounting.attempted).toBe(32);
  expect(admit).toHaveBeenCalledTimes(32);
  expect(base.result.nominations.map(row => row.source.source_id)).not.toContain("raw-unvisited-winner");

  admit.mockClear();
  const listed = run(16);
  expect(listed.result.nominations).toEqual(base.result.nominations);
  expect(listed.result.accounting).toEqual(base.result.accounting);
  expect(listed.result.resources).toEqual(base.result.resources);
  expect(listed.index_members).toHaveLength(16);
  expect(listed.index_members![1]!.source_id).toBe("raw-unvisited-winner");
});

it("interleaves raw-passage tail in question-time 3-way overflow without exceeding max_attempts", () => {
  const original = Array.from({ length: 16 }, (_, i) => templateStatement(`lex-${i}`));
  const preferred = Array.from({ length: 12 }, (_, i) => templateStatement(`qt-${i}`));
  const rawWinner = templateStatement("raw-winner");
  const stmtRows = Array.from({ length: 18 }, (_, i) => templateStatement(`stmt-${i}`));
  const config = configuration({ dimensions: 2, window_bytes: 8 });
  const profileId = sourceIndexProfileId(config.profile, fieldSha256);
  const binding = {
    workspace_id: "workspace-template", selection_revision: 1, config_id: "cfg-1",
    profile_id: profileId, generation_id: "gen-1", source_epoch: 1, dimensions: 2
  };
  const candidates: SourceIndexVectorRead["candidates"] = [
    ...stmtRows.map((row, i) => ({
      source: row.statement.source,
      window: { window_id: `ws-${i}`, start_byte: 0, end_byte: 8, content_digest: `sha256:${"a".repeat(64)}` },
      embedding: Float32Array.of(0.98 - i * 0.01, 0.1)
    })),
    {
      source: rawWinner.source,
      window: { window_id: "wr-0", start_byte: 0, end_byte: 8, content_digest: `sha256:${"b".repeat(64)}` },
      embedding: Float32Array.of(0.85, 0.1)
    }
  ];
  const admit = vi.fn<SourceIndexQueryRepository["admitQueryCandidate"]>(() => ({
    status: "ready", scope_class: "project", resources: empty
  }));
  const repository: SourceIndexQueryRepository = {
    readLexicalCandidates: (_workspace, _query, limit, _budget, time) => lexical((time ? preferred : original).slice(0, limit)),
    readVectorCandidates: () => ({
      completion: "complete", reason: null, candidates, resources: empty,
      state: { status: "ready", binding }, resource_refusal: null, cursor: null,
      inspected: candidates.length, invalid: 0
    }),
    readQuestionTimeDomain: () => ({ status: "ready", exists: true, matched_root_keys: [], resources: empty }),
    admitQueryCandidate: admit
  };
  const inputFor = (maxAttempts: number): SourceIndexAcquisitionInput => ({
    workspace_id: "workspace-template", navigation_text: "game",
    allowance: { max_attempts: maxAttempts, max_roots: 16, max_vector_windows: 64 },
    budget: templateBudget,
    vector: {
      status: "available", profile: config.profile, profile_id: profileId,
      input_digest: digest("game"), embedding: Float32Array.of(1, 0)
    },
    question_time: { interpretation_clock: template.interpretation_clock, intervals: [{ start: "2026-09-01", end: "2026-09-06" }] }
  });
  const run = (maxAttempts: number, members: number) => new SourceIndexAcquisition(repository, fieldSha256)
    .nominateWithWitness(inputFor(maxAttempts), () => "admitted", "original", undefined, undefined, undefined, undefined, members);

  admit.mockClear();
  const base = run(64, 0);
  const baseCalls = admit.mock.calls.length;
  admit.mockClear();
  const listed = run(64, 16);
  expect(admit.mock.calls.length).toBeLessThanOrEqual(64);
  expect(listed.result.nominations).toEqual(base.result.nominations);
  expect(listed.result.accounting).toEqual(base.result.accounting);
  expect(listed.result.resources).toEqual(base.result.resources);
  expect(listed.index_members!.map(row => row.source_id)).toContain("raw-winner");

  // With max_attempts === baseCalls (maxExtraAttempts === 0), no uncached tail calls are made.
  admit.mockClear();
  const capped = run(baseCalls, 16);
  expect(admit).toHaveBeenCalledTimes(baseCalls);
  expect(capped.result.nominations).toEqual(base.result.nominations);
});
