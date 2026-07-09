#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  SIGNALS,
  ISOTONIC_SOURCE_SIGNALS,
  readQuestions,
  buildExamples,
  summarizeSignalComparison,
  summarizeFeatureAvailability,
  summarizeSignal,
  summarizeRocAuc,
  summarizeIsotonic,
  signalDefinition,
  calibratedSignalName
} from "./evaluate-abstention-calibration-lib.mjs";

function usage() {
  return [
    "Usage:",
    `  node ${basename(process.argv[1])} --diagnostics <longmemeval-diagnostics.json> [--include-sweep]`,
    "",
    "Reports compact threshold summaries over available confidence and margin signals.",
    "Use --include-sweep when the full threshold table is needed.",
    "True *_abs rows are hold-out evaluation only; threshold search uses",
    "answerable rows plus leave-gold-out synthetic negatives when possible."
  ].join("\n");
}

function parseArgs(argv) {
  const args = { diagnostics: null, includeSweep: false };
  for (let index = 2; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--diagnostics") {
      args.diagnostics = argv[++index] ?? null;
      continue;
    }
    if (arg.startsWith("--diagnostics=")) {
      args.diagnostics = arg.slice("--diagnostics=".length);
      continue;
    }
    if (arg === "--include-sweep") {
      args.includeSweep = true;
      continue;
    }
    if (args.diagnostics === null && !arg.startsWith("--")) {
      args.diagnostics = arg;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (args.diagnostics === null) {
    throw new Error("missing --diagnostics");
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const sidecar = JSON.parse(await readFile(args.diagnostics, "utf8"));
  const questions = readQuestions(sidecar);
  const examples = buildExamples(questions);
  const isotonic = summarizeIsotonic(examples);
  const report = {
    schema_version: "abstention-calibration-eval.v1",
    diagnostics_path: args.diagnostics,
    run_metadata: {
      bench_name: sidecar.bench_name ?? null,
      split: sidecar.split ?? null,
      run_at: sidecar.run_at ?? null,
      alaya_commit: sidecar.alaya_commit ?? null,
      embedding_mode: sidecar.embedding_mode ?? null,
      embedding_provider: sidecar.embedding_provider ?? null
    },
    counts: {
      questions_total: questions.length,
      answerable_training: examples.answerable.length,
      synthetic_negatives: examples.syntheticNegatives.length,
      synthetic_skipped_no_delivered_gold: examples.syntheticSkippedNoDeliveredGold,
      true_abstention_holdout: examples.holdoutAbstentions.length
    },
    calibration_boundary: {
      threshold_search_uses_true_abs_holdout: false,
      roc_auc_uses_true_abs_holdout_for_evaluation_only: true,
      roc_auc_excludes_synthetic_negatives: true,
      synthetic_negative_strategy: "leave_gold_out_delivered_results_only",
      premise_invalid_available: false,
      premise_invalid_default: false,
      isotonic_fit_uses_true_abs_holdout: false,
      limitation:
        "This sidecar does not expose premise-validity labels; premise_invalid is reported false and excluded from threshold search."
    },
    runtime_handoff: {
      scorer_field: "abstention_confidence_score",
      scorer_threshold: 0.91,
      fused_margin_scale: 1 / 60,
      producer:
        "apps/bench-runner/src/longmemeval/abstention-confidence.ts — fused_score ranking dominance (top1−top2 and top1−mean(top2..top5)) with scale=1/60 (RRF k), never relevance_score",
      missing_confidence_behavior:
        "scoreAbstentionQuestion treats missing/null confidence as correct abstention (auto-pass)",
      threshold_reflection:
        "Runtime uses scale=1/60 with threshold 0.91; a live LongMemEval reflection run may still retune the threshold. This script reports ROC/AUC for raw fused margins, runtime confidence, and isotonic-calibrated variants without claiming a production AUC."
    },
    signal_comparison: {
      ...summarizeSignalComparison(),
      isotonic: ISOTONIC_SOURCE_SIGNALS.map(calibratedSignalName)
    },
    feature_availability: summarizeFeatureAvailability(examples),
    signals: [
      ...SIGNALS.map((signal) =>
        summarizeSignal(examples.training, examples.holdoutAbstentions, signal, {
          includeSweep: args.includeSweep
        })
      ),
      ...isotonic.signals
    ],
    roc_auc: [
      ...SIGNALS.map((signal) => ({
        ...signalDefinition(signal),
        ...summarizeRocAuc(examples.answerable, examples.holdoutAbstentions, signal)
      })),
      ...isotonic.roc
    ],
    isotonic_calibration: {
      algorithm: "pava",
      fit_split: "answerable_plus_synthetic_leave_gold_out",
      holdout: "true_abstention_only",
      fits: isotonic.fits
    }
  };
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(usage());
  process.exit(1);
});
