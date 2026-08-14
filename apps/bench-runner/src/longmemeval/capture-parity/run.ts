import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertCaptureParityWindow,
  compareCaptureParity,
  type CaptureParityReport,
  type CaptureParityView
} from "@do-soul/alaya-core";
import { computeLongMemEvalQuestionIdDigest } from "@do-soul/alaya-eval";
import {
  startBenchDaemon,
  type BenchDaemonHandle
} from "../../harness/daemon.js";
import { finalizeOwnedTempRoot } from "../lifecycle/owned-temp-root.js";
import { throwLifecycleErrors } from "../lifecycle/errors.js";
import type { RecallEvalOptions } from
  "../lifecycle/recall-eval/recall-eval-contract.js";
import {
  prepareRecallEvalRunContext,
  type RecallEvalRunContext
} from "../lifecycle/recall-eval/recall-eval-run-context.js";
import { recallEvalOneQuestion } from
  "../lifecycle/recall-eval/question/recall-eval-question.js";
import { recallOptionsForQuestion } from
  "../lifecycle/recall-eval/recall-eval-question-options.js";
import { captureRecallEvalQuestion } from
  "../lifecycle/recall-eval/recall-eval-selection-replay.js";
import { LONGMEMEVAL_SELECTION_REPLAY_ENV } from
  "../selection-replay/selection-boundary-spool.js";
import { extractCaptureParityViewFromEval } from "./extract.js";
import { sha256File } from "../snapshot/integrity.js";
import { measureGitState } from
  "../provenance/contract/frozen-code-contract.js";
import { computeExecutedDistIdentityFresh } from
  "../provenance/executed-dist-identity.js";
import {
  assertCaptureParityArmAuthority,
  type CaptureParityArmAuthority
} from "./authority.js";

export interface CaptureParityRunOptions {
  readonly snapshotDbPath: string;
  readonly outputPath: string;
  readonly variant: RecallEvalOptions["variant"];
  readonly historyRoot: string;
  readonly dataDirRoot: string;
  readonly policyShape?: RecallEvalOptions["policyShape"];
  readonly querySemanticFactorCachePath?: string;
}

export type CaptureParityRunReport = Readonly<CaptureParityReport & {
  authority: Readonly<{
    snapshot_db_sha256: string;
    code: Readonly<{
      commit_sha: string;
      worktree_state_sha256: string;
      executed_dist: ExecutedDistIdentity;
    }>;
    arm: CaptureParityArmAuthority;
  }>;
}>;

type ExecutedDistIdentity = Readonly<{
  algorithm: "sha256-reachable-path-file-sha256-v1";
  sha256: string;
  file_count: number;
}>;

export async function runCaptureParity(
  options: CaptureParityRunOptions,
  ambientEnv: Readonly<Record<string, string | undefined>> = process.env
): Promise<CaptureParityRunReport> {
  const snapshotDbSha256 = await sha256File(options.snapshotDbPath);
  const code = await captureParityCodeIdentity();
  const captureOff = await collectArm(options, ambientEnv, false);
  const captureOn = await collectArm(options, ambientEnv, true);
  if (captureOff.sidecarQuestionCount !== captureOn.sidecarQuestionCount) {
    throw new Error(
      `capture parity sidecar_question_count differs: off=${captureOff.sidecarQuestionCount} on=${captureOn.sidecarQuestionCount}`
    );
  }
  assertCaptureParityArmAuthority(captureOff.authority, captureOn.authority);
  if (await sha256File(options.snapshotDbPath) !== snapshotDbSha256) {
    throw new Error("capture parity snapshot DB changed during execution");
  }
  const report = compareCaptureParity(
    captureOff.views,
    captureOn.views,
    captureOff.sidecarQuestionCount
  );
  return Object.freeze({
    ...report,
    authority: Object.freeze({
      snapshot_db_sha256: snapshotDbSha256,
      code,
      arm: captureOff.authority
    })
  });
}

async function collectArm(
  options: CaptureParityRunOptions,
  ambientEnv: Readonly<Record<string, string | undefined>>,
  captureOn: boolean
): Promise<Readonly<{
  views: readonly CaptureParityView[];
  sidecarQuestionCount: number;
  authority: CaptureParityArmAuthority;
}>> {
  const arm = captureOn ? "capture-on" : "capture-off";
  const dataDirRoot = join(options.dataDirRoot, arm);
  const historyRoot = join(options.historyRoot, arm);
  await mkdir(dataDirRoot, { recursive: true });
  await mkdir(historyRoot, { recursive: true });
  const env = envForArm(ambientEnv, captureOn);
  const context = await prepareRecallEvalRunContext(
    recallEvalOptions(options, dataDirRoot, historyRoot),
    undefined,
    env
  );
  assertCaptureParityWindow(context.window.length, context.sidecarQuestionCount);
  const views = await collectArmQuestions(context, arm);
  if (views.length !== context.window.length) {
    throw new Error(
      `capture parity collected ${views.length} questions for window_length=${context.window.length}`
    );
  }
  return {
    views,
    sidecarQuestionCount: context.sidecarQuestionCount,
    authority: armAuthority(context)
  };
}

function armAuthority(context: RecallEvalRunContext): CaptureParityArmAuthority {
  return Object.freeze({
    dataset_sha256: context.datasetSha256,
    question_id_digest: computeLongMemEvalQuestionIdDigest(
      context.window.map((question) => question.questionId)
    ),
    runtime_attribution: context.runtimeAttribution
  });
}

async function captureParityCodeIdentity(): Promise<
  CaptureParityRunReport["authority"]["code"]
> {
  const checkoutRoot = resolve(
    dirname(fileURLToPath(import.meta.url)), "../../../../.."
  );
  const [git, rawExecutedDist] = await Promise.all([
    measureGitState(checkoutRoot),
    computeExecutedDistIdentityFresh()
  ]);
  return Object.freeze({
    commit_sha: git.commitSha,
    worktree_state_sha256: git.worktreeStateSha256,
    executed_dist: requireExecutedDistIdentity(rawExecutedDist)
  });
}

function requireExecutedDistIdentity(value: unknown): ExecutedDistIdentity {
  const row = value as Partial<ExecutedDistIdentity> | null;
  if (row === null || row.algorithm !== "sha256-reachable-path-file-sha256-v1" ||
      !/^[a-f0-9]{64}$/u.test(row.sha256 ?? "") ||
      !Number.isSafeInteger(row.file_count) || (row.file_count ?? 0) <= 0) {
    throw new Error("capture parity executed dist identity is invalid");
  }
  return row as ExecutedDistIdentity;
}

async function collectArmQuestions(
  context: RecallEvalRunContext,
  arm: string
): Promise<readonly CaptureParityView[]> {
  const daemon = await startBenchDaemon({
    dataDirRoot: context.dataDirRoot,
    embeddingMode: context.daemonLaunch.embeddingMode,
    embeddingProviderKind: context.daemonLaunch.embeddingProviderKind,
    recallWeightOverrides: context.recallWeightOverrides
  }, context.daemonLaunch);
  let views: readonly CaptureParityView[] = [];
  let primaryError: unknown;
  try {
    views = await collectQuestions(context, daemon, arm);
  } catch (error) {
    primaryError = error;
  }
  const shutdownError = await captureCleanup(() => daemon.shutdown());
  const spoolError = await captureCleanup(async () => {
    await context.selectionBoundarySpool?.dispose();
  });
  const dataRootError = await captureCleanup(() => finalizeOwnedTempRoot(
    { path: context.dataDirRoot, owned: context.ownsDataDirRoot },
    primaryError === undefined
  ));
  throwLifecycleErrors(`capture-parity ${arm} failed`, [
    primaryError, shutdownError, spoolError, dataRootError
  ]);
  return views;
}

async function collectQuestions(
  context: RecallEvalRunContext,
  daemon: BenchDaemonHandle,
  arm: string
): Promise<readonly CaptureParityView[]> {
  const views: CaptureParityView[] = [];
  for (let index = 0; index < context.window.length; index += 1) {
    const question = context.window[index];
    if (question === undefined) continue;
    const result = await captureRecallEvalQuestion(
      context.selectionBoundarySpool, question.questionId,
      (selectionBoundaryObserver) => recallEvalOneQuestion({
        daemon, question, turnIndex: index + 1,
        embeddingMode: context.daemonLaunch.embeddingMode,
        recallOptions: recallOptionsForQuestion(
          context, question.question, selectionBoundaryObserver
        ),
        simulateReport: context.simulateReport,
        measurement: context.measurementForQuestion?.(question.questionId)
      })
    );
    views.push(extractCaptureParityViewFromEval(result));
    process.stdout.write(
      `[capture-parity ${arm} ${index + 1}/${context.window.length}] ` +
        `${question.questionId.slice(0, 8)}\n`
    );
  }
  return views;
}

function recallEvalOptions(
  options: CaptureParityRunOptions,
  dataDirRoot: string,
  historyRoot: string
): RecallEvalOptions {
  return {
    snapshotDbPath: options.snapshotDbPath,
    variant: options.variant,
    historyRoot,
    dataDirRoot,
    ...(options.policyShape === undefined ? {} : { policyShape: options.policyShape }),
    ...(options.querySemanticFactorCachePath === undefined
      ? {}
      : { querySemanticFactorCachePath: options.querySemanticFactorCachePath })
  };
}

function envForArm(
  ambientEnv: Readonly<Record<string, string | undefined>>,
  captureOn: boolean
): Record<string, string | undefined> {
  const env = { ...ambientEnv };
  if (captureOn) env[LONGMEMEVAL_SELECTION_REPLAY_ENV] = "1";
  else delete env[LONGMEMEVAL_SELECTION_REPLAY_ENV];
  return env;
}

async function captureCleanup(cleanup: () => Promise<void>): Promise<unknown> {
  try {
    await cleanup();
    return undefined;
  } catch (error) {
    return error;
  }
}
