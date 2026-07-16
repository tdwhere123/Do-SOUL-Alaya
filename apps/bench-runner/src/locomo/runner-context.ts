import type { BenchEmbeddingMode } from "../harness/daemon.js";
import {
  createCompileSeedRunner,
  resolveBenchAllowLiveExtraction,
  type CompileSeedRunner
} from "../longmemeval/compile-seed.js";
import { resolveBenchEmbeddingProviderLabel } from "../longmemeval/runner.js";
import { resolveBenchRunnerVersion } from "../shared/version.js";
import type { LocomoSample } from "./dataset.js";
import { loadLocomo } from "./fetch.js";
import type { LocomoRunOptions } from "./runner-types.js";
import {
  collectDistinctLocomoTurnContents,
  resolveCommitSha7
} from "./runner-utils.js";

export interface LocomoRunContext {
  readonly conversations: readonly LocomoSample[];
  readonly window: readonly LocomoSample[];
  readonly alayaVersion: string;
  readonly commitSha7: string;
  readonly runAt: Date;
  readonly embeddingMode: BenchEmbeddingMode;
  readonly embeddingProvider: string;
  readonly seedRunner: CompileSeedRunner;
}

export async function prepareLocomoRun(
  opts: LocomoRunOptions
): Promise<LocomoRunContext> {
  const conversations = await loadLocomo(opts.variant, {
    dataDir: opts.dataDir,
    pinnedMetaRoot: opts.pinnedMetaRoot
  });
  const window = selectLocomoWindow(conversations, opts);
  const embeddingMode = opts.embeddingMode ?? "disabled";
  return {
    conversations,
    window,
    alayaVersion: resolveBenchRunnerVersion(),
    commitSha7: resolveCommitSha7(),
    runAt: new Date(),
    embeddingMode,
    embeddingProvider: resolveBenchEmbeddingProviderLabel(
      embeddingMode,
      process.env,
      opts.embeddingProviderKind
    ),
    seedRunner: createLocomoSeedRunner(window, Math.max(0, opts.offset ?? 0))
  };
}

function selectLocomoWindow(
  conversations: readonly LocomoSample[],
  opts: LocomoRunOptions
): readonly LocomoSample[] {
  const offset = Math.max(0, opts.offset ?? 0);
  const sliceEnd = opts.limit !== undefined ? offset + opts.limit : conversations.length;
  return conversations.slice(offset, sliceEnd);
}

function createLocomoSeedRunner(
  window: readonly LocomoSample[],
  offset: number
): CompileSeedRunner {
  return createCompileSeedRunner({
    requiredTurnContents: collectDistinctLocomoTurnContents(window),
    requiredQuestionWindow: { offset, limit: window.length },
    ...(resolveBenchAllowLiveExtraction() ? { allowLiveExtraction: true } : {})
  });
}
