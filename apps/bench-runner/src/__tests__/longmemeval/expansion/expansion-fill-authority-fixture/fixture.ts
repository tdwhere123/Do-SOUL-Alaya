import { vi, type Mock } from "vitest";
import type { CompileSeedExtractionConfig } from
  "../../../../longmemeval/compile-seed/compile-seed-types.js";
import type { ExtractionFillCompletion } from
  "../../../../longmemeval/extraction/fill/fill-completion.js";
import type { LongMemEvalQuestion } from "../../../../longmemeval/ingestion/dataset.js";
import type {
  LoadedLongMemEvalDataset,
  VerifiedLongMemEvalDatasetAuthority
} from "../../../../longmemeval/ingestion/fetch.js";
import type { ExtractionCacheManifestIdentity } from
  "../../../../longmemeval/extraction/cache/extraction-cache-manifest.js";
import { syntheticExtractionClosure } from "../../extraction/extraction-closure-fixture.js";
import {
  buildFixtureSourceManifest,
  buildFixtureTargetManifest
} from "./manifest.js";

export interface ExpansionFillAuthorityFixtureState {
  identity: ExtractionCacheManifestIdentity | undefined;
  dataset: LoadedLongMemEvalDataset;
  config: CompileSeedExtractionConfig & { readonly modelFamily: string };
  sourceCompletion: ExtractionFillCompletion;
  targetCompletion: ExtractionFillCompletion;
  verifyIntegrity: Mock;
  substrateBinding: Mock;
  seedLedgerBinding: Mock;
}

const state = vi.hoisted<ExpansionFillAuthorityFixtureState>(() => ({
  identity: undefined,
  dataset: datasetFixture(),
  config: {
    providerUrl: "https://provider.example/v1",
    model: "gpt-5.4-mini",
    modelFamily: "gpt-5.4-mini",
    requestProfile: "provider-default-v1" as const,
    apiKey: "test-key"
  },
  sourceCompletion: {
    expectedTurns: 100, validTurns: 100, missingTurns: 0,
    invalidTurns: 0, orphanTurns: 0, coverage: 1,
    expectedKeySetSha256: "7".repeat(64),
    contentClosureSha256: "9".repeat(64)
  } as ExtractionFillCompletion,
  targetCompletion: {
    expectedTurns: 500, validTurns: 100, missingTurns: 400,
    invalidTurns: 0, orphanTurns: 0, coverage: 0.2,
    expectedKeySetSha256: "8".repeat(64),
    contentClosureSha256: null as string | null
  } as ExtractionFillCompletion,
  verifyIntegrity: vi.fn(),
  substrateBinding: vi.fn(),
  seedLedgerBinding: vi.fn()
}));

vi.mock("../../../../longmemeval/ingestion/fetch.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../longmemeval/ingestion/fetch.js")>(),
  loadDatasetWithIdentity: vi.fn(async () => state.dataset)
}));
vi.mock("../../../../longmemeval/extraction/cache/extraction-cache-manifest.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../longmemeval/extraction/cache/extraction-cache-manifest.js")>(),
  readExtractionCacheManifestIdentity: vi.fn(() => state.identity)
}));
vi.mock("../../../../longmemeval/compile-seed/compile-seed-config.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../longmemeval/compile-seed/compile-seed-config.js")>(),
  resolveCompileSeedExtractionConfig: vi.fn(() => state.config)
}));
vi.mock("../../../../longmemeval/extraction/fill/fill-completion.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../longmemeval/extraction/fill/fill-completion.js")>(),
  inspectExtractionFillCompletion: vi.fn((input: { turnContents: readonly string[] }) =>
    input.turnContents.length === 100 ? state.sourceCompletion : state.targetCompletion)
}));
vi.mock("../../../../longmemeval/snapshot/integrity.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../longmemeval/snapshot/integrity.js")>(),
  verifySnapshotArtifactIntegrity: state.verifyIntegrity
}));
vi.mock("../../../../longmemeval/snapshot/substrate-binding.js", () => ({
  assertSnapshotDatasetSubstrateIdentity: state.substrateBinding
}));
vi.mock("../../../../longmemeval/snapshot/seed-ledger/seed-ledger-binding.js", () => ({
  assertSnapshotSeedLedgerBinding: state.seedLedgerBinding
}));

export function resetExpansionFillAuthorityFixture(): void {
  state.config = {
    providerUrl: "https://provider.example/v1",
    model: "gpt-5.4-mini",
    modelFamily: "gpt-5.4-mini",
    requestProfile: "provider-default-v1",
    apiKey: "test-key"
  };
  state.dataset = datasetFixture();
  state.sourceCompletion = completion(100, 100, "7", "9");
  state.targetCompletion = completion(500, 100, "8", null);
  state.identity = {
    manifestSha256: "a".repeat(64),
    manifest: sourceManifest()
  };
  state.verifyIntegrity.mockReset();
  state.substrateBinding.mockReset();
  state.seedLedgerBinding.mockReset();
}

export function sourceManifest() {
  return buildFixtureSourceManifest(state.config);
}

export function targetManifest(
  anchor: Parameters<typeof buildFixtureTargetManifest>[1],
  status: "in_progress" | "complete" = "in_progress"
) {
  return buildFixtureTargetManifest(state.config, anchor, status);
}

export function completion(
  expected: number,
  valid: number,
  key: string,
  closure: string | null
): ExtractionFillCompletion {
  const exact = closureFixture(expected);
  const canonicalKey = expected === 100 ? "7" : "8";
  const canonicalClosure = expected === 100 ? "9" : "6";
  return {
    expectedTurns: expected,
    validTurns: valid,
    missingTurns: expected - valid,
    invalidTurns: 0,
    orphanTurns: 0,
    coverage: valid / expected,
    expectedKeySetSha256: key === canonicalKey
      ? exact.expected_key_set_sha256
      : key.repeat(64),
    partialContentClosureSha256: closure === null
      ? null
      : closure === canonicalClosure
        ? exact.content_closure_sha256
        : closure.repeat(64),
    contentClosureSha256: closure === null
      ? null
      : closure === canonicalClosure
        ? exact.content_closure_sha256
        : closure.repeat(64),
    contentClosureIndex: valid === expected && closure !== null
      ? exact.content_closure_index
      : null
  };
}

export function closureFixture(expected: number) {
  return syntheticExtractionClosure({
    count: expected,
    model: state.config.model,
    requestProfile: state.config.requestProfile,
    seed: expected === 100 ? "expansion-source" : "expansion-target"
  });
}

export function datasetFixture(): LoadedLongMemEvalDataset {
  const questions = Array.from({ length: 500 }, (_, index) => question(index));
  return {
    questions,
    sha256: "d".repeat(64),
    checksumSource: "/dataset.meta.json",
    sourcePath: "/dataset.json",
    promotionAuthority: {} as VerifiedLongMemEvalDatasetAuthority
  };
}

function question(index: number): LongMemEvalQuestion {
  return {
    question_id: `question-${index + 1}`,
    question_type: "single-session-user",
    question: `question ${index + 1}`,
    answer: `answer ${index + 1}`,
    question_date: "2026-01-01",
    haystack_session_ids: [`session-${index + 1}`],
    haystack_dates: ["2026-01-01"],
    haystack_sessions: [[{ role: "user", content: `turn ${index + 1}` }]],
    answer_session_ids: [`session-${index + 1}`]
  };
}

export { state };
