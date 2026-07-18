import path from "node:path";
import process from "node:process";
import type {
  BenchPolicyShape,
  BenchSimulateReportMode
} from "@do-soul/alaya-eval";
import {
  DEFAULT_BENCH_EMBEDDING_PROVIDER_KIND,
  type BenchEmbeddingMode,
  type BenchEmbeddingProviderKind
} from "../harness/daemon/daemon-types.js";
import type { LongMemEvalVariant } from "../longmemeval/ingestion/dataset.js";
import { consumePromotionEvidencePathFlags } from "./cli-options-promotion.js";
import {
  matchFlagToken,
  nextIndex,
  parseNonNegativeInt,
  parsePositiveInt,
  readFlagValue,
  readRequiredFlagValue
} from "./options/flag-values.js";

const DEFAULT_HISTORY_ROOT = path.resolve(process.cwd(), "docs/bench-history");

export interface ParsedFlags {
  readonly variant: LongMemEvalVariant;
  readonly limit?: number;
  readonly offset?: number;
  readonly historyRoot: string;
  readonly dataDir?: string;
  readonly shards?: ReadonlyArray<string>;
  readonly source?: string;
  readonly embeddingMode: BenchEmbeddingMode;
  readonly embeddingProviderKind: BenchEmbeddingProviderKind;
  readonly policyShape: BenchPolicyShape;
  readonly simulateReport: BenchSimulateReportMode;
  readonly weightOverridesJson?: string;
  readonly rounds?: number;
  readonly force: boolean;
  readonly snapshot?: string;
  readonly snapshotOut?: string;
  readonly dataDirRoot?: string;
  readonly pinnedMetaRoot?: string;
  readonly questionManifest?: string;
  readonly extractionCacheRoot?: string;
  /** Digest-bound extraction authority receipt required for live cache fills. */
  readonly extractionAuthority?: string;
  /** Immutable target-root selection receipt linked from a normal authority receipt. */
  readonly extractionTargetSelection?: string;
  readonly promotionContract?: string;
  readonly r3SpendApproval?: string;
  readonly concurrency?: number;
  readonly questionBatchLimit?: number;
  readonly legacySnapshot: boolean;
  readonly legacyManifestSha256?: string;
  readonly legacyDatasetSha256?: string;
  // --qa gates the end-to-end QA harness; default off means zero LLM calls/cost.
  readonly qa: boolean;
  // --edge-plane: drain the BULK_ENRICH edge pass before recall (cumulative
  // modes only). Default off keeps embedding ON/OFF corpora comparable.
  readonly edgePlane: boolean;
}

export interface ParsedFlagsState {
  variantRaw: string;
  limit?: number;
  offset?: number;
  historyRoot: string;
  dataDir?: string;
  source?: string;
  embeddingMode: BenchEmbeddingMode;
  embeddingProviderKind: BenchEmbeddingProviderKind;
  policyShape: BenchPolicyShape;
  simulateReport: BenchSimulateReportMode;
  weightOverridesJson?: string;
  rounds?: number;
  force: boolean;
  snapshot?: string;
  snapshotOut?: string;
  dataDirRoot?: string;
  pinnedMetaRoot?: string;
  questionManifest?: string;
  extractionCacheRoot?: string;
  extractionAuthority?: string;
  extractionTargetSelection?: string;
  promotionContract?: string;
  r3SpendApproval?: string;
  concurrency?: number;
  questionBatchLimit?: number;
  legacySnapshot: boolean;
  legacyManifestSha256?: string;
  legacyDatasetSha256?: string;
  qa: boolean;
  edgePlane: boolean;
  shards: string[];
  collectingShards: boolean;
}

export function parseFlags(args: ReadonlyArray<string>): ParsedFlags {
  const state = createParsedFlagsState();
  for (let i = 0; i < args.length; i += 1) {
    i = consumeFlagToken(args, i, state);
  }
  return finalizeParsedFlags(state);
}

function createParsedFlagsState(): ParsedFlagsState {
  return {
    variantRaw: "oracle",
    historyRoot: DEFAULT_HISTORY_ROOT,
    embeddingMode: "disabled",
    embeddingProviderKind: DEFAULT_BENCH_EMBEDDING_PROVIDER_KIND,
    policyShape: "stress",
    simulateReport: "none",
    force: false,
    qa: false,
    edgePlane: false,
    legacySnapshot: false,
    shards: [],
    collectingShards: false
  };
}

function consumeFlagToken(
  args: ReadonlyArray<string>,
  index: number,
  state: ParsedFlagsState
): number {
  const token = args[index] ?? "";
  if (token === "--shards") {
    state.collectingShards = true;
    return index;
  }
  if (state.collectingShards && !token.startsWith("--")) {
    state.shards.push(token);
    return index;
  }
  state.collectingShards = false;

  if (token === "--variant") {
    state.variantRaw = args[index + 1] ?? "oracle";
    return index + 1;
  }
  if (token === "--limit") {
    state.limit = parsePositiveInt(args[index + 1], "--limit");
    return index + 1;
  }
  if (token === "--offset") {
    state.offset = parseNonNegativeInt(args[index + 1], "--offset");
    return index + 1;
  }
  if (token === "--rounds") {
    state.rounds = parsePositiveInt(args[index + 1], "--rounds");
    return index + 1;
  }
  if (token === "--history-root") {
    state.historyRoot = args[index + 1] ?? DEFAULT_HISTORY_ROOT;
    return index + 1;
  }
  if (token === "--embedding") {
    state.embeddingMode = parseEmbeddingMode(args[index + 1] ?? "disabled");
    return index + 1;
  }
  return consumeExtendedFlagToken(args, index, token, state);
}

function consumeExtendedFlagToken(
  args: ReadonlyArray<string>,
  index: number,
  token: string,
  state: ParsedFlagsState
): number {
  if (matchFlagToken(token, "--embedding-provider")) {
    state.embeddingProviderKind = parseEmbeddingProviderKind(
      readFlagValue(
        args, index, token, "--embedding-provider",
        DEFAULT_BENCH_EMBEDDING_PROVIDER_KIND
      ) ?? DEFAULT_BENCH_EMBEDDING_PROVIDER_KIND
    );
    return nextIndex(index, token);
  }
  if (matchFlagToken(token, "--policy-shape")) {
    state.policyShape = parsePolicyShape(
      readFlagValue(args, index, token, "--policy-shape", "stress") ?? "stress"
    );
    return nextIndex(index, token);
  }
  if (matchFlagToken(token, "--simulate-report")) {
    state.simulateReport = parseSimulateReport(
      readFlagValue(args, index, token, "--simulate-report", "none") ?? "none"
    );
    return nextIndex(index, token);
  }
  if (matchFlagToken(token, "--weights")) {
    state.weightOverridesJson = readRequiredFlagValue(
      args,
      index,
      token,
      "--weights",
      "--weights requires a JSON value"
    );
    return nextIndex(index, token);
  }
  return consumePathAndBooleanFlags(args, index, token, state);
}

function consumePathAndBooleanFlags(
  args: ReadonlyArray<string>,
  index: number,
  token: string,
  state: ParsedFlagsState
): number {
  const pathIndex = consumePathFlags(args, index, token, state);
  if (pathIndex !== undefined) {
    return pathIndex;
  }
  return consumeBooleanFlags(args, index, token, state);
}

function consumePathFlags(
  args: ReadonlyArray<string>,
  index: number,
  token: string,
  state: ParsedFlagsState
): number | undefined {
  const manifestIndex = consumeQuestionManifestFlag(args, index, token, state);
  if (manifestIndex !== undefined) return manifestIndex;
  return consumeOtherPathFlags(args, index, token, state);
}

function consumeQuestionManifestFlag(
  args: ReadonlyArray<string>,
  index: number,
  token: string,
  state: ParsedFlagsState
): number | undefined {
  if (!matchFlagToken(token, "--question-manifest")) return undefined;
  state.questionManifest = readRequiredFlagValue(
    args,
    index,
    token,
    "--question-manifest",
    "--question-manifest requires a path"
  );
  return nextIndex(index, token);
}

function consumeOtherPathFlags(
  args: ReadonlyArray<string>,
  index: number,
  token: string,
  state: ParsedFlagsState
): number | undefined {
  const promotionEvidenceIndex = consumePromotionEvidencePathFlags(args, index, token, state);
  if (promotionEvidenceIndex !== undefined) return promotionEvidenceIndex;
  const legacyIdentityIndex = consumeLegacyIdentityFlags(args, index, token, state);
  if (legacyIdentityIndex !== undefined) return legacyIdentityIndex;
  if (token === "--data-dir") {
    state.dataDir = args[index + 1];
    return index + 1;
  }
  if (matchFlagToken(token, "--snapshot-out")) {
    state.snapshotOut = readFlagValue(args, index, token, "--snapshot-out");
    return nextIndex(index, token);
  }
  if (matchFlagToken(token, "--data-dir-root")) {
    state.dataDirRoot = readFlagValue(args, index, token, "--data-dir-root");
    return nextIndex(index, token);
  }
  if (matchFlagToken(token, "--pinned-meta-root")) {
    state.pinnedMetaRoot = readFlagValue(args, index, token, "--pinned-meta-root");
    return nextIndex(index, token);
  }
  if (matchFlagToken(token, "--extraction-cache-root")) {
    state.extractionCacheRoot = readFlagValue(args, index, token, "--extraction-cache-root");
    return nextIndex(index, token);
  }
  if (matchFlagToken(token, "--extraction-authority")) {
    state.extractionAuthority = readRequiredFlagValue(
      args,
      index,
      token,
      "--extraction-authority",
      "--extraction-authority requires a receipt path"
    );
    return nextIndex(index, token);
  }
  if (matchFlagToken(token, "--extraction-target-selection")) {
    state.extractionTargetSelection = readRequiredFlagValue(
      args,
      index,
      token,
      "--extraction-target-selection",
      "--extraction-target-selection requires a receipt path"
    );
    return nextIndex(index, token);
  }
  if (matchFlagToken(token, "--snapshot")) {
    state.snapshot = readFlagValue(args, index, token, "--snapshot");
    return nextIndex(index, token);
  }
  if (matchFlagToken(token, "--concurrency")) {
    state.concurrency = parsePositiveInt(
      readFlagValue(args, index, token, "--concurrency"), "--concurrency"
    );
    return nextIndex(index, token);
  }
  if (matchFlagToken(token, "--question-batch-limit")) {
    state.questionBatchLimit = parsePositiveInt(
      readFlagValue(args, index, token, "--question-batch-limit"),
      "--question-batch-limit"
    );
    return nextIndex(index, token);
  }
  return undefined;
}

function consumeLegacyIdentityFlags(
  args: ReadonlyArray<string>,
  index: number,
  token: string,
  state: ParsedFlagsState
): number | undefined {
  if (matchFlagToken(token, "--legacy-manifest-sha256")) {
    state.legacyManifestSha256 = readRequiredFlagValue(
      args, index, token, "--legacy-manifest-sha256",
      "--legacy-manifest-sha256 requires a SHA-256 value"
    );
    return nextIndex(index, token);
  }
  if (matchFlagToken(token, "--legacy-dataset-sha256")) {
    state.legacyDatasetSha256 = readRequiredFlagValue(
      args, index, token, "--legacy-dataset-sha256",
      "--legacy-dataset-sha256 requires a SHA-256 value"
    );
    return nextIndex(index, token);
  }
  return undefined;
}

function consumeBooleanFlags(
  args: ReadonlyArray<string>,
  index: number,
  token: string,
  state: ParsedFlagsState
): number {
  if (token === "--force") {
    state.force = true;
    return index;
  }
  if (token === "--qa" || token === "--answer-judge") {
    state.qa = true;
    return index;
  }
  if (token === "--edge-plane") {
    state.edgePlane = true;
    return index;
  }
  if (token === "--legacy-snapshot") {
    state.legacySnapshot = true;
    return index;
  }
  if (token === "--source") {
    state.source = args[index + 1];
    return index + 1;
  }
  return index;
}

function parseEmbeddingMode(raw: string): BenchEmbeddingMode {
  if (raw !== "disabled" && raw !== "env") {
    throw new Error("--embedding must be one of: disabled, env");
  }
  return raw;
}

function parseEmbeddingProviderKind(raw: string): BenchEmbeddingProviderKind {
  if (raw !== "openai" && raw !== "local_onnx") {
    throw new Error("--embedding-provider must be one of: openai, local_onnx");
  }
  return raw;
}

function parsePolicyShape(raw: string): BenchPolicyShape {
  if (raw !== "stress" && raw !== "chat") {
    throw new Error("--policy-shape must be one of: stress, chat");
  }
  return raw;
}

function parseSimulateReport(raw: string): BenchSimulateReportMode {
  if (
    raw !== "none" &&
    raw !== "always-used" &&
    raw !== "gold-only" &&
    raw !== "mixed"
  ) {
    throw new Error(
      "--simulate-report must be one of: none, always-used, gold-only, mixed"
    );
  }
  return raw;
}

function finalizeParsedFlags(state: ParsedFlagsState): ParsedFlags {
  const variantMap: Record<string, LongMemEvalVariant> = {
    oracle: "longmemeval_oracle",
    s: "longmemeval_s",
    m: "longmemeval_m",
    longmemeval_oracle: "longmemeval_oracle",
    longmemeval_s: "longmemeval_s",
    longmemeval_m: "longmemeval_m"
  };
  return {
    variant: variantMap[state.variantRaw] ?? "longmemeval_oracle",
    limit: state.limit,
    offset: state.offset,
    historyRoot: state.historyRoot,
    dataDir: state.dataDir,
    shards: state.shards.length > 0 ? state.shards : undefined,
    source: state.source,
    embeddingMode: state.embeddingMode,
    embeddingProviderKind: state.embeddingProviderKind,
    policyShape: state.policyShape,
    simulateReport: state.simulateReport,
    weightOverridesJson: state.weightOverridesJson,
    rounds: state.rounds,
    force: state.force,
    snapshot: state.snapshot,
    snapshotOut: state.snapshotOut,
    dataDirRoot: state.dataDirRoot,
    pinnedMetaRoot: state.pinnedMetaRoot,
    questionManifest: state.questionManifest,
    extractionCacheRoot: state.extractionCacheRoot,
    extractionAuthority: state.extractionAuthority,
    extractionTargetSelection: state.extractionTargetSelection,
    promotionContract: state.promotionContract,
    r3SpendApproval: state.r3SpendApproval,
    concurrency: state.concurrency,
    questionBatchLimit: state.questionBatchLimit,
    legacySnapshot: state.legacySnapshot,
    legacyManifestSha256: state.legacyManifestSha256,
    legacyDatasetSha256: state.legacyDatasetSha256,
    qa: state.qa,
    edgePlane: state.edgePlane
  };
}
