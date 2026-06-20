import path from "node:path";
import process from "node:process";
import type {
  BenchPolicyShape,
  BenchSimulateReportMode
} from "@do-soul/alaya-eval";
import type { BenchEmbeddingMode, BenchEmbeddingProviderKind } from "../harness/daemon.js";
import type { LongMemEvalVariant } from "../longmemeval/dataset.js";

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
  readonly extractionCacheRoot?: string;
  readonly concurrency?: number;
  // --qa: gate the end-to-end QA harness (answer-LLM + LLM-judge). Default off
  // => zero LLM calls, zero cost, recall path + kpi bytes unchanged.
  readonly qa: boolean;
  // --edge-plane: drain the BULK_ENRICH edge pass before recall (cumulative
  // modes only). Default off keeps embedding ON/OFF corpora comparable.
  readonly edgePlane: boolean;
}

interface ParsedFlagsState {
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
  extractionCacheRoot?: string;
  concurrency?: number;
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
    embeddingProviderKind: "openai",
    policyShape: "stress",
    simulateReport: "none",
    force: false,
    qa: false,
    edgePlane: false,
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
    state.limit = parsePositiveInt(args[index + 1]);
    return index + 1;
  }
  if (token === "--offset") {
    state.offset = parseNonNegativeInt(args[index + 1]);
    return index + 1;
  }
  if (token === "--rounds") {
    state.rounds = parsePositiveInt(args[index + 1]);
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
      readFlagValue(args, index, token, "--embedding-provider", "openai") ??
        "openai"
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
    state.extractionCacheRoot = readFlagValue(
      args,
      index,
      token,
      "--extraction-cache-root"
    );
    return nextIndex(index, token);
  }
  if (matchFlagToken(token, "--snapshot")) {
    state.snapshot = readFlagValue(args, index, token, "--snapshot");
    return nextIndex(index, token);
  }
  if (matchFlagToken(token, "--concurrency")) {
    state.concurrency = parsePositiveInt(
      readFlagValue(args, index, token, "--concurrency")
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
  if (token === "--source") {
    state.source = args[index + 1];
    return index + 1;
  }
  return index;
}

function matchFlagToken(token: string, flag: string): boolean {
  return token === flag || token.startsWith(`${flag}=`);
}

function nextIndex(index: number, token: string): number {
  return token.includes("=") ? index : index + 1;
}

function readFlagValue(
  args: ReadonlyArray<string>,
  index: number,
  token: string,
  flag: string,
  fallback?: string
): string | undefined {
  if (token.startsWith(`${flag}=`)) {
    return token.slice(flag.length + 1);
  }
  return args[index + 1] ?? fallback;
}

function readRequiredFlagValue(
  args: ReadonlyArray<string>,
  index: number,
  token: string,
  flag: string,
  errorMessage: string
): string {
  const raw = readFlagValue(args, index, token, flag);
  if (raw === undefined) {
    throw new Error(errorMessage);
  }
  return raw;
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  return parseIntegerFlag(raw, (value) => value > 0);
}

function parseNonNegativeInt(raw: string | undefined): number | undefined {
  return parseIntegerFlag(raw, (value) => value >= 0);
}

function parseIntegerFlag(
  raw: string | undefined,
  predicate: (value: number) => boolean
): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const parsed = parseInt(raw, 10);
  return !Number.isNaN(parsed) && predicate(parsed) ? parsed : undefined;
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
    extractionCacheRoot: state.extractionCacheRoot,
    concurrency: state.concurrency,
    qa: state.qa,
    edgePlane: state.edgePlane
  };
}
