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
  const report = buildReport({ args, sidecar, questions, examples, isotonic });
  console.log(JSON.stringify(report, null, 2));
}

function buildReport({ args, sidecar, questions, examples, isotonic }) {
  return {
    schema_version: "abstention-calibration-eval.v1",
    diagnostics_path: args.diagnostics,
    run_metadata: runMetadata(sidecar),
    counts: exampleCounts(questions, examples),
    calibration_boundary: calibrationBoundary(),
    runtime_handoff: runtimeHandoff(),
    signal_comparison: {
      ...summarizeSignalComparison(),
      isotonic: ISOTONIC_SOURCE_SIGNALS.map(calibratedSignalName)
    },
    feature_availability: summarizeFeatureAvailability(examples),
    signals: signalSummaries(args, examples, isotonic),
    roc_auc: rocAucSummaries(examples, isotonic),
    isotonic_calibration: {
      algorithm: "pava",
      fit_split: "answerable_plus_synthetic_leave_gold_out",
      holdout: "true_abstention_only",
      fits: isotonic.fits
    }
  };
}

function runMetadata(sidecar) {
  return {
    bench_name: sidecar.bench_name ?? null,
    split: sidecar.split ?? null,
    run_at: sidecar.run_at ?? null,
    alaya_commit: sidecar.alaya_commit ?? null,
    embedding_mode: sidecar.embedding_mode ?? null,
    embedding_provider: sidecar.embedding_provider ?? null
  };
}

function exampleCounts(questions, examples) {
  return {
    questions_total: questions.length,
    answerable_training: examples.answerable.length,
    synthetic_negatives: examples.syntheticNegatives.length,
    synthetic_skipped_no_delivered_gold: examples.syntheticSkippedNoDeliveredGold,
    true_abstention_holdout: examples.holdoutAbstentions.length
  };
}

function calibrationBoundary() {
  return {
    threshold_search_uses_true_abs_holdout: false,
    roc_auc_uses_true_abs_holdout_for_evaluation_only: true,
    roc_auc_excludes_synthetic_negatives: true,
    synthetic_negative_strategy: "leave_gold_out_delivered_results_only",
    premise_invalid_available: false,
    premise_invalid_default: false,
    isotonic_fit_uses_true_abs_holdout: false,
    limitation:
      "This sidecar does not expose premise-validity labels; premise_invalid is reported false and excluded from threshold search."
  };
}

function runtimeHandoff() {
  return {
    status: "uncalibrated",
    scorable: false,
    recall_scope: "answerable_recall",
    abstention_handling: "excluded_from_recall_denominator",
    promotion_eligible: false,
    scorer_field: null,
    scorer_threshold: null,
    diagnostic_field: "abstention_confidence_score",
    diagnostic_fused_margin_scale: 1 / 60,
    diagnostic_producer:
      "apps/bench-runner/src/longmemeval/abstention-confidence.ts — fused_score ranking dominance (top1−top2 and top1−mean(top2..top5)) with scale=1/60 (RRF k), never relevance_score",
    missing_confidence_behavior:
      "Missing, null, or present confidence does not change the fail-closed unscorable verdict.",
    threshold_reflection:
      "There is no runtime abstention threshold. This script reports offline ROC/AUC and sweep evidence without creating a production scorer and without claiming a production AUC.",
    historical_threshold_reference: {
      value: 0.91,
      scope: "offline_comparison_only",
      current_runtime_effect: false
    }
  };
}

function signalSummaries(args, examples, isotonic) {
  return [
    ...SIGNALS.map((signal) =>
      summarizeSignal(examples.training, examples.holdoutAbstentions, signal, {
        includeSweep: args.includeSweep
      })
    ),
    ...isotonic.signals
  ];
}

function rocAucSummaries(examples, isotonic) {
  return [
    ...SIGNALS.map((signal) => ({
      ...signalDefinition(signal),
      ...summarizeRocAuc(examples.answerable, examples.holdoutAbstentions, signal)
    })),
    ...isotonic.roc
  ];
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(usage());
  process.exit(1);
});
