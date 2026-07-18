import { createHash } from "node:crypto";
import type { PreparedExpansionFillAuthority } from
  "../../../../longmemeval/extraction/expansion-fill-authority.js";
import { prepareExpansionFillAuthority } from
  "../../../../longmemeval/extraction/expansion-fill-authority.js";
import {
  buildLongMemEvalMatrixPromotionAuthorization,
  hashPromotionMatrix
} from "../../../../longmemeval/promotion/schema/authorization.js";
import { parseLongMemEvalMatrixPromotionContract } from
  "../../../../longmemeval/promotion/schema/contract.js";
import {
  verifyLongMemEvalExpansionCapability,
  longMemEvalExpansionCapabilityData,
  type LongMemEvalExpansionCapability,
  type LongMemEvalSourceSnapshotAuthority
} from "../../../../longmemeval/promotion/expansion/expansion-capability.js";
import {
  createLongMemEvalSelectionContract,
  selectionContractIdentity
} from "../../../../longmemeval/selection/contract.js";
import {
  EXTRACTION_CACHE_KEY_ALGO,
  computeSystemPromptSha256
} from "../../../../longmemeval/extraction/cache/extraction-cache-manifest.js";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import { redactProvenanceUrl } from
  "../../../../longmemeval/provenance/paired-environment.js";
import type { R3SpendApproval } from
  "../../../../longmemeval/promotion/r3-spend-approval.js";
import {
  expansionHardGateFixture,
  expansionPromotionContractFixture
} from "../expansion-promotion-contract-fixture.js";
import { closureFixture, state } from "./fixture.js";
import { fixtureSupplementalSourceBinding } from "./manifest.js";
import { computeSupplementalSourceBindingSha256 } from
  "../../../../longmemeval/extraction/cache/supplemental-source-receipt.js";

export async function prepare(
  capabilityPromise: Promise<LongMemEvalExpansionCapability>
): Promise<PreparedExpansionFillAuthority> {
  const capability = await capabilityPromise;
  return prepareExpansionFillAuthority({
    variant: "longmemeval_s",
    expansionCapability: capability,
    r3SpendApproval: r3SpendApprovalFor(capability)
  }, "/cache").then((result) => result!);
}

export async function mintCapability(
  sourceManifestSha = "a".repeat(64)
): Promise<LongMemEvalExpansionCapability> {
  const contract = expansionPromotionContractFixture();
  const contents = Buffer.from(JSON.stringify(contract), "utf8");
  const parsed = parseLongMemEvalMatrixPromotionContract(contents);
  const labels = ["A", "B", "C", "D"] as const;
  const cells = contract.matrix.entries.map((entry, index) => ({
    cell: labels[index]!,
    treatment: entry.treatment,
    evidence_root: entry.evidence_root,
    bundle_sha256: String(index + 1).repeat(64)
  }));
  const sourceSelection = selection(state.dataset.questions.slice(0, 100));
  const nextSelection = selection(state.dataset.questions);
  const authorization = buildLongMemEvalMatrixPromotionAuthorization({
    schema_version: 1,
    kind: "longmemeval_matrix_promotion_authorization",
    status: "authorized",
    contract_sha256: parsed.sha256,
    policy_version: contract.policy_version,
    source_selection: sourceSelection,
    next_selection: nextSelection,
    matrix: { sha256: hashPromotionMatrix(cells), cells },
    product_default: {
      cell: "B",
      treatment: cells[1]!.treatment,
      bundle_sha256: cells[1]!.bundle_sha256
    },
    hard_gates: [expansionHardGateFixture()]
  });
  return verifyLongMemEvalExpansionCapability({
    checkoutRoot: "/repo",
    contractPath: "/evidence/contract.json",
    contractRoot: "/evidence",
    contractContents: contents
  }, {
    authorize: async () => authorization,
    readSourceSnapshotAuthority: async () => sourceAuthority(sourceManifestSha),
    resolveFrozenCodeIdentity: async () => ({
      commitSha: contract.code.commit_sha,
      commitSha7: contract.code.commit_sha7,
      gateContractPath: "/evidence/contract.json",
      gateSha256: parsed.sha256,
      worktreeStateSha256: contract.code.worktree_state_sha256,
      worktreeClean: true
    }),
    computeExecutedDistIdentity: async () => contract.code.executed_dist
  });
}

export function r3SpendApprovalFor(
  capability: LongMemEvalExpansionCapability
): R3SpendApproval {
  const identity = state.identity;
  if (identity === undefined) throw new Error("fixture requires a cache manifest identity");
  const data = longMemEvalExpansionCapabilityData(capability);
  const startingMissing = state.targetCompletion.missingTurns;
  return {
    schema_version: 1,
    kind: "longmemeval_r3_spend_approval",
    status: "approved",
    operator: { identity: "fixture-operator", approved_at: "2026-07-17T00:00:00.000Z" },
    r2: {
      matrix_authorization_sha256: data.matrixAuthorizationSha256,
      source_selection_sha256: selectionSha256(data.sourceSelection),
      source_selected_count: data.sourceSelection.selected_count,
      final_cache_identity_sha256: identity.manifestSha256,
      hard_gates_passed: true,
      answerable_count: 94,
      b_a_net_r5_wins: 5,
      mcnemar: { method: "exact_two_sided", p_value: 0.049 }
    },
    target: {
      selection_sha256: selectionSha256(data.nextSelection),
      selected_count: data.nextSelection.selected_count,
      cache_identity_sha256: identity.manifestSha256
    },
    spend: {
      starting_missing: startingMissing,
      maximum_attempts: Math.ceil(startingMissing * 1.1),
      successful_shard_ceiling: startingMissing,
      estimated_cost_usd: 1,
      disk_floor_bytes: 0
    }
  };
}

function sourceAuthority(manifestSha256: string): LongMemEvalSourceSnapshotAuthority {
  const closure = closureFixture(100);
  return {
    dbPath: "snapshot/source-100.db",
    manifestSha256: "f".repeat(64),
    dbSha256: "e".repeat(64),
    sidecarSha256: "1".repeat(64),
    extractionCache: {
      manifestSha256,
      extractionModel: state.config.model,
      modelFamily: state.config.modelFamily,
      requestProfile: state.config.requestProfile,
      providerUrl: redactProvenanceUrl(state.config.providerUrl),
      systemPromptSha256: computeSystemPromptSha256(OFFICIAL_API_SYSTEM_PROMPT),
      cacheKeyAlgo: EXTRACTION_CACHE_KEY_ALGO,
      dataset: "longmemeval-s",
      datasetRevision: "d".repeat(64),
      windowOffset: 0,
      windowLimit: 100,
      expectedTurns: closure.expected_turns,
      expectedKeySetSha256: closure.expected_key_set_sha256,
      contentClosureSha256: closure.content_closure_sha256,
      supplementalSourceBindingSha256: computeSupplementalSourceBindingSha256(
        fixtureSupplementalSourceBinding(),
        redactProvenanceUrl
      )
    }
  };
}

function selection(questions: readonly typeof state.dataset.questions[number][]) {
  return selectionContractIdentity(createLongMemEvalSelectionContract({
    datasetSha256: "d".repeat(64),
    questions
  }));
}

function selectionSha256(selection: Readonly<Record<string, unknown>>): string {
  return createHash("sha256").update(JSON.stringify({
    schema_version: selection.schema_version,
    dataset_sha256: selection.dataset_sha256,
    selected_id_digest: selection.selected_id_digest,
    selected_count: selection.selected_count,
    expected_cohort_counts: selection.expected_cohort_counts,
    cohort_assignment_digest: selection.cohort_assignment_digest
  }), "utf8").digest("hex");
}
