import { isDeepStrictEqual } from "node:util";
import {
  collectReleaseHardGates,
  type LongMemEvalSelectionContractIdentity
} from "@do-soul/alaya-eval";
import {
  buildLongMemEvalMatrixPromotionAuthorization,
  hashPromotionMatrix,
  type LongMemEvalMatrixPromotionAuthorization
} from "./authorization.js";
import {
  matrixCellForTreatment,
  productDefaultTreatment,
  treatmentKey,
  type LongMemEvalMatrixPromotionContract
} from "./contract.js";
import {
  verifiedRecallEvalPromotionEntryData,
  type VerifiedRecallEvalPromotionEntry,
  type VerifiedRecallEvalPromotionEntryData
} from "../verifiers/entry-verifier.js";
import { assertPromotionProductDefaultPolicy } from
  "../verifiers/product-policy-verifier.js";

export interface VerifiedPromotionMatrixCell {
  readonly evidenceRoot: string;
  readonly entry: VerifiedRecallEvalPromotionEntry;
}

interface ResolvedPromotionMatrixCell {
  readonly evidenceRoot: string;
  readonly data: VerifiedRecallEvalPromotionEntryData;
}

const CELL_ORDER = ["A", "B", "C", "D"] as const;
const REQUIRED_PIPELINE_GATES = [
  "longmemeval_s_non_monotonic_rate",
  "longmemeval_s_budget_dropped_rate",
  "longmemeval_s_no_gold",
  "longmemeval_s_evaluator_identity_issue",
  "longmemeval_s_evidence_stream_gold_delivery"
] as const;

export function authorizeVerifiedLongMemEvalMatrix(input: {
  readonly contract: LongMemEvalMatrixPromotionContract;
  readonly contractSha256: string;
  readonly sourceSelection: LongMemEvalSelectionContractIdentity;
  readonly nextSelection: LongMemEvalSelectionContractIdentity;
  readonly cells: readonly VerifiedPromotionMatrixCell[];
}): LongMemEvalMatrixPromotionAuthorization {
  const cells = indexCells(input);
  assertSelectionProgression(input.sourceSelection, input.nextSelection);
  assertCommonIdentity([...cells.values()]);
  assertPairedTreatmentIdentity(cells);
  const product = resolveProductDefaultCell(
    cells,
    input.contract.policy_version
  );
  const { productCell, productTreatment } = product;
  assertPromotionProductDefaultPolicy(productCell.data);
  const hardGates = collectReleaseHardGates(productCell.data.payload);
  assertMandatoryProductGates(hardGates);
  return renderMatrixAuthorization(input, cells, product, hardGates);
}

function resolveProductDefaultCell(
  cells: ReadonlyMap<"A" | "B" | "C" | "D", ResolvedPromotionMatrixCell>,
  policyVersion: LongMemEvalMatrixPromotionContract["policy_version"]
) {
  const productTreatment = productDefaultTreatment(policyVersion);
  const productCell = cells.get(matrixCellForTreatment(productTreatment));
  if (productCell === undefined || matrixCellForTreatment(productTreatment) !== "B") {
    throw new Error("product-default policy does not resolve to matrix cell B");
  }
  return { productCell, productTreatment };
}

function renderMatrixAuthorization(
  input: Parameters<typeof authorizeVerifiedLongMemEvalMatrix>[0],
  cells: ReadonlyMap<"A" | "B" | "C" | "D", ResolvedPromotionMatrixCell>,
  product: ReturnType<typeof resolveProductDefaultCell>,
  hardGates: ReturnType<typeof collectReleaseHardGates>
): LongMemEvalMatrixPromotionAuthorization {
  const renderedCells = CELL_ORDER.map((cell) => renderMatrixCell(cells, cell));
  return buildLongMemEvalMatrixPromotionAuthorization({
    schema_version: 1,
    kind: "longmemeval_matrix_promotion_authorization",
    status: "authorized",
    contract_sha256: input.contractSha256,
    policy_version: input.contract.policy_version,
    source_selection: input.sourceSelection,
    next_selection: input.nextSelection,
    matrix: {
      sha256: hashPromotionMatrix(renderedCells),
      cells: renderedCells
    },
    product_default: {
      cell: "B",
      treatment: product.productTreatment,
      bundle_sha256: product.productCell.data.manifest.bundle_sha256
    },
    hard_gates: hardGates.map((gate) => ({
      ...gate,
      passed: true as const,
      missing: false as const
    }))
  });
}

function renderMatrixCell(
  cells: ReadonlyMap<"A" | "B" | "C" | "D", ResolvedPromotionMatrixCell>,
  cell: typeof CELL_ORDER[number]
) {
  const entry = cells.get(cell)!;
  return {
    cell,
    treatment: entry.data.treatment,
    evidence_root: entry.evidenceRoot,
    bundle_sha256: entry.data.manifest.bundle_sha256
  };
}

function indexCells(input: Parameters<typeof authorizeVerifiedLongMemEvalMatrix>[0]) {
  if (input.cells.length !== 4) throw new Error("promotion matrix requires four verified cells");
  const byCell = new Map<"A" | "B" | "C" | "D", ResolvedPromotionMatrixCell>();
  const contractByTreatment = new Map(input.contract.matrix.entries.map(
    (entry) => [treatmentKey(entry.treatment), entry]
  ));
  for (const cell of input.cells) {
    const data = verifiedRecallEvalPromotionEntryData(cell.entry);
    const label = matrixCellForTreatment(data.treatment);
    const declared = contractByTreatment.get(treatmentKey(data.treatment));
    if (declared === undefined || declared.evidence_root !== cell.evidenceRoot ||
        byCell.has(label)) {
      throw new Error("verified matrix cells differ from promotion contract");
    }
    assertEqual(
      data.payload.selection_contract,
      input.sourceSelection,
      `${label} source selection`
    );
    byCell.set(label, { evidenceRoot: cell.evidenceRoot, data });
  }
  if (CELL_ORDER.some((cell) => !byCell.has(cell))) {
    throw new Error("promotion matrix is not the exact treatment Cartesian product");
  }
  return byCell;
}

function assertSelectionProgression(
  source: LongMemEvalSelectionContractIdentity,
  next: LongMemEvalSelectionContractIdentity
): void {
  if (source.dataset_sha256 !== next.dataset_sha256 ||
      source.selected_count >= next.selected_count) {
    throw new Error("promotion selection must progress from a prefix to the full dataset");
  }
}

function assertCommonIdentity(cells: readonly ResolvedPromotionMatrixCell[]): void {
  const reference = commonIdentity(cells[0]!.data);
  for (const cell of cells.slice(1)) {
    assertEqual(commonIdentity(cell.data), reference, "matrix common evidence identity");
  }
}

function commonIdentity(data: VerifiedRecallEvalPromotionEntryData) {
  const payload = data.payload;
  const provenance = data.provenance;
  const attribution = payload.recall_eval_attribution!;
  return {
    manifest_run: {
      bench_name: data.manifest.run.bench_name,
      split: data.manifest.run.split,
      alaya_commit: data.manifest.run.alaya_commit,
      dataset_sha256: data.manifest.run.dataset_sha256,
      question_id_digest: data.manifest.run.question_id_digest,
      selection_contract: data.manifest.run.selection_contract
    },
    payload: {
      alaya_commit: payload.alaya_commit,
      alaya_version: payload.alaya_version,
      recall_pipeline_version: payload.recall_pipeline_version,
      policy_shape: payload.policy_shape,
      simulate_report: payload.simulate_report,
      recall_weight_overrides: payload.recall_weight_overrides,
      dataset: payload.dataset,
      sample_size: payload.sample_size,
      evaluated_count: payload.evaluated_count,
      selection_contract: payload.selection_contract,
      seed_extraction_path: payload.kpi.seed_extraction_path,
      snapshot_binding: attribution.snapshot_binding,
      hydration_binding: attribution.hydration_binding,
      recall_config: attribution.recall_config
    },
    provenance: {
      dataset_sha256: provenance.dataset_sha256,
      selection: provenance.selection,
      code: provenance.code,
      extraction_cache: provenance.extraction_cache,
      execution: provenance.execution,
      recall_config: provenance.recall_config,
      seed_capabilities: provenance.seed_capabilities,
      question_manifest: provenance.question_manifest,
      runtime: {
        node_version: provenance.runtime.node_version,
        platform: provenance.runtime.platform,
        arch: provenance.runtime.arch,
        embedding_provider_kind: provenance.runtime.embedding_provider_kind,
        onnx_threads: provenance.runtime.onnx_threads,
        paired_env: nonTreatmentEnvironment(provenance.runtime.paired_env)
      }
    }
  };
}

function nonTreatmentEnvironment(
  paired: Readonly<Record<string, string>>
): Readonly<Record<string, string>> {
  const treatmentKeys = new Set([
    "ALAYA_ENABLE_EMBEDDING_SUPPLEMENT",
    "ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK",
    "ALAYA_RECALL_EVAL_EMBEDDING"
  ]);
  return Object.fromEntries(
    Object.entries(paired).filter(([key]) => !treatmentKeys.has(key))
  );
}

function assertPairedTreatmentIdentity(
  cells: ReadonlyMap<"A" | "B" | "C" | "D", ResolvedPromotionMatrixCell>
): void {
  const a = cells.get("A")!.data.diagnosticsRuntime;
  const b = cells.get("B")!.data.diagnosticsRuntime;
  const c = cells.get("C")!.data.diagnosticsRuntime;
  const d = cells.get("D")!.data.diagnosticsRuntime;
  if (a.embedding_supplement.enabled || c.embedding_supplement.enabled ||
      a.answer_rerank.enabled || b.answer_rerank.enabled ||
      !b.embedding_supplement.enabled || !d.embedding_supplement.enabled ||
      !c.answer_rerank.enabled || !d.answer_rerank.enabled) {
    throw new Error("matrix treatment activation does not match A/B/C/D semantics");
  }
  assertEqual(b.embedding_supplement, d.embedding_supplement,
    "B/D bi-encoder model identity");
  assertEqual(c.answer_rerank, d.answer_rerank,
    "C/D cross-encoder model identity");
}

function assertMandatoryProductGates(
  gates: ReturnType<typeof collectReleaseHardGates>
): void {
  const ids = new Set(gates.map((gate) => gate.id));
  const hasRecall = gates.some((gate) =>
    /^longmemeval_s_\d+_embedding_on_r_at_5$/u.test(gate.id)
  );
  const mandatory = [
    "longmemeval_measurement_attribution",
    "embedding_provider_returned_rate",
    "longmemeval_s_embedding_inference_calls_mean",
    "recall_p95_embedding_on",
    ...REQUIRED_PIPELINE_GATES
  ];
  if (!hasRecall || mandatory.some((id) => !ids.has(id))) {
    throw new Error("product-default cell is missing a mandatory executable hard gate");
  }
  const failed = gates.filter((gate) => !gate.passed || gate.missing);
  if (failed.length > 0) {
    throw new Error(
      `product-default cell failed hard gates: ${failed.map((gate) => gate.id).join(", ")}`
    );
  }
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`${label} differs`);
}
