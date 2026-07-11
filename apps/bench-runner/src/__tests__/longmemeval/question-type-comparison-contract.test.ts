import { describe, expect, it } from "vitest";
import { compareLongMemEvalQuestionTypes } from "../../longmemeval/comparison/question-type-comparison.js";
import {
  DATASET_SHA,
  buildManifestFixture,
  dataset,
  datasetQuestion,
  kpi,
  provenance
} from "./question-type-comparison-test-fixtures.js";

function withCache(
  enabled: boolean,
  cache: Readonly<Record<string, unknown>>,
  questionManifest: unknown
): unknown {
  const value = provenance(enabled) as { extraction_cache: object };
  return {
    ...(value as object),
    extraction_cache: { ...value.extraction_cache, ...cache },
    question_manifest: questionManifest
  };
}

function withoutCodeField(enabled: boolean, field: string): unknown {
  const value = provenance(enabled) as { code: Record<string, unknown> };
  return { ...value, code: { ...value.code, [field]: null } };
}

function withExecution(
  enabled: boolean,
  execution: Readonly<Record<string, unknown>>
): unknown {
  const value = provenance(enabled) as { execution: object };
  return { ...value, execution: { ...value.execution, ...execution } };
}

describe("LongMemEval question-type dataset contracts", () => {
  it("accepts source sessions for abstention rows and classifies by question ID", () => {
    const abstention = datasetQuestion("supported_abs", "multi-session");
    const rows = [{ id: abstention.question_id, hit_at_5: false }];
    const comparison = compareLongMemEvalQuestionTypes({
      dataset: [abstention],
      control: kpi(rows),
      treatment: kpi(rows),
      allowLegacyUnattributed: true
    });
    expect(comparison.answerability).toEqual(expect.arrayContaining([
      expect.objectContaining({ cohort: "answerable", total: 0 }),
      expect.objectContaining({ cohort: "abstention", total: 1 })
    ]));
  });

  it("fails closed on missing or blank source session IDs", () => {
    const invalidRows = [
      { ...datasetQuestion("missing-gold", "multi-session"), answer_session_ids: [] },
      { ...datasetQuestion("missing-source_abs", "multi-session"), answer_session_ids: [] },
      { ...datasetQuestion("blank-gold", "multi-session"), answer_session_ids: [" "] }
    ];
    for (const invalid of invalidRows) {
      expect(() => compareLongMemEvalQuestionTypes({
        dataset: [invalid],
        control: kpi([]),
        treatment: kpi([]),
        allowLegacyUnattributed: true
      })).toThrow(/answer_session_ids.*non-empty/u);
    }
  });

  it("parses the full LongMemEval question contract", () => {
    const malformed = { ...dataset[0] } as Record<string, unknown>;
    delete malformed.haystack_sessions;
    expect(() => compareLongMemEvalQuestionTypes({
      dataset: [malformed],
      control: kpi([]),
      treatment: kpi([]),
      allowLegacyUnattributed: true
    })).toThrow(/dataset\[0\] invalid:[\s\S]*haystack_sessions/u);
  });

});

describe("LongMemEval question-type manifest contracts", () => {
  it("reuses the strict manifest contract and binds it to the dataset SHA", () => {
    const { base, manifest, rows } = buildManifestFixture();
    expect(() => compareLongMemEvalQuestionTypes(base)).toThrow(/requires the supplied question manifest/u);
    expect(() => compareLongMemEvalQuestionTypes({
      ...base,
      manifest: { ...manifest, selected_id_digest: "f".repeat(64) }
    })).toThrow(/selected-ID digest mismatch/u);
    expect(() => compareLongMemEvalQuestionTypes({
      ...base,
      datasetSha256: "b".repeat(64),
      manifest
    })).toThrow(/dataset SHA-256 mismatch/u);
    expect(() => compareLongMemEvalQuestionTypes({
      ...base,
      manifest: { ...manifest, target_count: manifest.target_count - 1 }
    })).toThrow(/target_count/u);
    expectManifestQuestionSetMismatch(base, manifest, rows.slice(1));
  });

  it("accepts only the explicit unpinned cache sentinel with manifest binding", () => {
    const { base, identity, manifest } = buildManifestFixture();
    const input = { ...base, manifest };
    const cache = {
      dataset_revision: "unpinned",
      requested_turns: 1284,
      cached_turns: 96084,
      coverage: 1
    };
    expect(() => compareLongMemEvalQuestionTypes({
      ...input,
      controlProvenance: withCache(false, cache, identity),
      treatmentProvenance: withCache(true, cache, identity)
    })).not.toThrow();
    expectInvalidCacheBindings(input, identity, cache);
  });

  it("binds snapshot KPI unpinned checksums through the supplied manifest", () => {
    const { base, identity, manifest, rows } = buildManifestFixture();
    const input = {
      ...base,
      manifest,
      control: kpi(rows, 100, "unpinned"),
      treatment: kpi(rows, 100, "unpinned"),
      controlProvenance: withCache(false, { dataset_revision: "unpinned" }, identity),
      treatmentProvenance: withCache(true, { dataset_revision: "unpinned" }, identity)
    };
    expect(() => compareLongMemEvalQuestionTypes(input)).not.toThrow();
    expect(() => compareLongMemEvalQuestionTypes({
      ...input,
      datasetSha256: "b".repeat(64)
    })).toThrow(/dataset SHA-256 mismatch/u);
    expect(() => compareLongMemEvalQuestionTypes({
      ...input,
      control: kpi(rows, 100, "main"),
      treatment: kpi(rows, 100, "main")
    })).toThrow(/KPI dataset checksum/u);
  });

});

describe("LongMemEval question-type provenance contracts", () => {
  it("requires the actual dataset SHA for attributed comparisons", () => {
    const rows = dataset.map((row) => ({ id: row.question_id, hit_at_5: true }));
    expect(() => compareLongMemEvalQuestionTypes({
      dataset,
      control: kpi(rows),
      treatment: kpi(rows),
      controlProvenance: provenance(false),
      treatmentProvenance: provenance(true)
    })).toThrow(/actual dataset SHA-256/u);
  });

  it("requires a manifest when attributed KPI rows are a dataset subset", () => {
    const selected = dataset.slice(0, 1);
    const rows = selected.map((row) => ({ id: row.question_id, hit_at_5: true }));
    expect(() => compareLongMemEvalQuestionTypes({
      dataset: dataset.slice(0, 2),
      datasetSha256: DATASET_SHA,
      control: kpi(rows),
      treatment: kpi(rows),
      controlProvenance: provenance(false, rows.length),
      treatmentProvenance: provenance(true, rows.length)
    })).toThrow(/manifest.*dataset subset/u);
  });

  it.each([
    ["offset", { offset: 1 }],
    ["limit", { limit: dataset.length }]
  ])("rejects manifest-free attributed comparisons with a partial %s window", (_name, execution) => {
    const rows = dataset.map((row) => ({ id: row.question_id, hit_at_5: true }));
    expect(() => compareLongMemEvalQuestionTypes({
      dataset,
      datasetSha256: DATASET_SHA,
      control: kpi(rows),
      treatment: kpi(rows),
      controlProvenance: withExecution(false, execution),
      treatmentProvenance: withExecution(true, execution)
    })).toThrow(/manifest-free.*full execution window/u);
  });

  it("rejects a slice experiment without seeded semantic endpoint projections", () => {
    const rows = dataset.map((row) => ({ id: row.question_id, hit_at_5: true }));
    const withoutFacetCapability = (value: unknown) => {
      const typed = value as { seed_capabilities?: unknown };
      const { seed_capabilities: _omitted, ...rest } = typed;
      return rest;
    };
    expect(() => compareLongMemEvalQuestionTypes({
      dataset,
      control: kpi(rows),
      treatment: kpi(rows),
      controlProvenance: withoutFacetCapability(provenance(false)),
      treatmentProvenance: withoutFacetCapability(provenance(true))
    })).toThrow(/ALAYA_RECALL_FACET_TAGS/u);
  });

  it("rejects non-sequential paired provenance", () => {
    const rows = dataset.map((row) => ({ id: row.question_id, hit_at_5: true }));
    expect(() => compareLongMemEvalQuestionTypes({
      dataset,
      control: kpi(rows),
      treatment: kpi(rows),
      controlProvenance: provenance(false),
      treatmentProvenance: {
        ...(provenance(true) as object),
        execution: { protocol: "sharded", concurrency: 2, offset: 0, limit: null, evaluated_count: rows.length }
      }
    })).toThrow(/sequential/u);
  });

  it.each([
    ["gate_sha256", /ALAYA_BENCH_GATE_SHA256/u],
    ["worktree_state_sha256", /ALAYA_BENCH_WORKTREE_STATE_SHA256/u]
  ])("fails attributed comparison when %s is absent", (field, error) => {
    const rows = dataset.map((row) => ({ id: row.question_id, hit_at_5: true }));
    expect(() => compareLongMemEvalQuestionTypes({
      dataset,
      control: kpi(rows),
      treatment: kpi(rows),
      controlProvenance: withoutCodeField(false, field),
      treatmentProvenance: withoutCodeField(true, field)
    })).toThrow(error);
  });

});

describe("LongMemEval question-type drift contracts", () => {
  it.each(provenanceDriftCases())("rejects $name drift", ({ mutate }) => {
    const rows = dataset.map((row) => ({ id: row.question_id, hit_at_5: true }));
    expect(() => compareLongMemEvalQuestionTypes({
      dataset,
      control: kpi(rows),
      treatment: kpi(rows),
      controlProvenance: provenance(false),
      treatmentProvenance: mutate(provenance(true))
    })).toThrow(/provenance or config mismatch/u);
  });

  it.each(invalidInputCases())("fails loudly on $name", ({ input, error }) => {
    const rows = (input.control as { kpi?: { per_scenario?: unknown[] } }).kpi?.per_scenario;
    const count = Array.isArray(rows) ? rows.length : dataset.length;
    expect(() => compareLongMemEvalQuestionTypes({
      ...input,
      controlProvenance: provenance(false, count),
      treatmentProvenance: provenance(true, count)
    })).toThrow(error);
  });
});

function expectManifestQuestionSetMismatch(
  base: ReturnType<typeof buildManifestFixture>["base"],
  manifest: ReturnType<typeof buildManifestFixture>["manifest"],
  rows: readonly { id: string; hit_at_5: boolean }[]
): void {
  expect(() => compareLongMemEvalQuestionTypes({
    ...base,
    control: kpi(rows),
    treatment: kpi(rows),
    controlProvenance: { ...(base.controlProvenance as object), execution: (provenance(false, rows.length) as { execution: object }).execution },
    treatmentProvenance: { ...(base.treatmentProvenance as object), execution: (provenance(true, rows.length) as { execution: object }).execution },
    manifest
  })).toThrow(/manifest\/KPI question set mismatch/u);
}

function expectInvalidCacheBindings(
  input: ReturnType<typeof buildManifestFixture>["base"] & { manifest: unknown },
  identity: unknown,
  cache: Readonly<Record<string, unknown>>
): void {
  const expectInvalid = (override: Readonly<Record<string, unknown>>, expected: RegExp, manifestIdentity = identity) => {
    expect(() => compareLongMemEvalQuestionTypes({
      ...input,
      controlProvenance: withCache(false, { ...cache, ...override }, manifestIdentity),
      treatmentProvenance: withCache(true, { ...cache, ...override }, manifestIdentity)
    })).toThrow(expected);
  };
  expectInvalid({}, /unpinned.*question manifest/u, null);
  expectInvalid({ dataset: "locomo" }, /logical dataset/u);
  expectInvalid({ dataset_revision: "main" }, /unsupported extraction cache dataset revision/u);
  expectInvalid({ dataset_revision: "b".repeat(64) }, /dataset revision does not match KPI dataset/u);
}

function provenanceDriftCases() {
  return [
    driftCase("gate SHA", "code", { gate_sha256: "a".repeat(64) }),
    driftCase("commit", "code", { commit_sha7: "abcdef0" }),
    driftCase("worktree state", "code", { worktree_state_sha256: "2".repeat(64) }),
    driftCase("cache manifest", "extraction_cache", { manifest_sha256: "a".repeat(64) }),
    driftCase("ONNX runtime", "runtime", { onnx_threads: 3 }),
    {
      name: "paired knob",
      mutate: (value: unknown) => {
        const typed = value as { runtime: { paired_env: object } };
        return { ...typed, runtime: { ...typed.runtime, paired_env: { ...typed.runtime.paired_env, ALAYA_BENCH_RECALL_MAXK: "50" } } };
      }
    }
  ];
}

function driftCase(name: string, field: "code" | "runtime" | "extraction_cache", patch: object) {
  return {
    name,
    mutate: (value: unknown) => {
      const typed = value as Record<typeof field, object>;
      return { ...typed, [field]: { ...typed[field], ...patch } };
    }
  };
}

function invalidInputCases() {
  return [
    {
      name: "duplicate dataset ids",
      input: { dataset: [...dataset, dataset[0]], control: kpi([]), treatment: kpi([]) },
      error: /duplicate dataset question_id 'b-lost'/u
    },
    {
      name: "duplicate KPI ids",
      input: { dataset: dataset.slice(0, 1), control: kpi([{ id: "b-lost", hit_at_5: true }, { id: "b-lost", hit_at_5: false }]), treatment: kpi([{ id: "b-lost", hit_at_5: true }]) },
      error: /duplicate control question id 'b-lost'/u
    },
    {
      name: "control and treatment set drift",
      input: { dataset: dataset.slice(0, 2), control: kpi([{ id: "b-lost", hit_at_5: true }]), treatment: kpi([{ id: "a-gained", hit_at_5: true }]) },
      error: /control\/treatment question set mismatch/u
    },
    {
      name: "unknown KPI ids",
      input: { dataset: dataset.slice(0, 1), control: kpi([{ id: "unknown", hit_at_5: true }]), treatment: kpi([{ id: "unknown", hit_at_5: true }]) },
      error: /unknown dataset question id 'unknown'/u
    },
    {
      name: "non-boolean hits",
      input: { dataset: dataset.slice(0, 1), control: { kpi: { per_scenario: [{ id: "b-lost", hit_at_5: 1 }] } }, treatment: kpi([{ id: "b-lost", hit_at_5: true }]) },
      error: /control.*hit_at_5 must be boolean/u
    },
    {
      name: "missing KPI ids",
      input: { dataset: dataset.slice(0, 1), control: { kpi: { per_scenario: [{ hit_at_5: true }] } }, treatment: kpi([{ id: "b-lost", hit_at_5: true }]) },
      error: /control.*\.id must be a non-empty string/u
    },
    {
      name: "absent hit verdicts",
      input: { dataset: dataset.slice(0, 1), control: { kpi: { per_scenario: [{ id: "b-lost" }] } }, treatment: kpi([{ id: "b-lost", hit_at_5: true }]) },
      error: /control.*hit_at_5 must be boolean/u
    }
  ];
}
