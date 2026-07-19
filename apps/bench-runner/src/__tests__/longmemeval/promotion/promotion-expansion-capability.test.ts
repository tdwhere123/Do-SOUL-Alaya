import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createLongMemEvalSelectionContractIdentity } from "@do-soul/alaya-eval";
import {
  buildLongMemEvalMatrixPromotionAuthorization
} from "../../../longmemeval/promotion/schema/authorization.js";
import {
  LongMemEvalMatrixPromotionContractSchema,
  matrixCellForTreatment,
  parseLongMemEvalMatrixPromotionContract
} from "../../../longmemeval/promotion/schema/contract.js";
import {
  longMemEvalExpansionCapabilityData,
  verifyLongMemEvalExpansionCapability,
  type LongMemEvalExpansionCapability,
  type LongMemEvalExpansionCapabilityDependencies,
  type LongMemEvalSourceSnapshotAuthority
} from "../../../longmemeval/promotion/expansion/expansion-capability.js";
import {
  expansionAbsoluteQualityPolicyFixture,
  expansionMaterialEffectFixture,
  expansionMaterialEffectPolicyFixture,
  expansionValidatorFixture
} from "../expansion/expansion-promotion-contract-fixture.js";

describe("LongMemEval 100Q to 500Q expansion capability", () => {
  it("seals the live-reverified matrix, code, snapshot, and cache closure", async () => {
    const fixture = expansionFixture();
    const capability = await verifyLongMemEvalExpansionCapability(
      fixture.input,
      fixture.dependencies
    );

    const data = longMemEvalExpansionCapabilityData(capability);
    expect(data).toMatchObject({
      contractSha256: fixture.parsed.sha256,
      policyVersion: "longmemeval-product-default-v1",
      sourceSelection: { selected_count: 100 },
      nextSelection: { selected_count: 500 },
      productDefault: { cell: "B" },
      materialEffect: { paired_r_at_5: { net: 9 } },
      validator: { commit_sha7: "abcdef0", worktree_clean: true },
      sourceSnapshot: {
        dbPath: "snapshot/source-100.db",
        extractionCache: {
          windowOffset: 0,
          windowLimit: 100,
          contentClosureSha256: "9".repeat(64)
        }
      }
    });
    expect(Object.isFrozen(data)).toBe(true);
    expect(Object.isFrozen(data.sourceSnapshot.extractionCache)).toBe(true);
  });

  it("rejects a plain object cast as an expansion capability", () => {
    expect(() => longMemEvalExpansionCapabilityData(
      {} as LongMemEvalExpansionCapability
    )).toThrow(/not live-verified/u);
  });

  it("does not treat a modified self-hashed authorization receipt as authority", () => {
    const fixture = expansionFixture();
    const { authorization_sha256: _digest, ...unsigned } = fixture.authorization;
    const modified = buildLongMemEvalMatrixPromotionAuthorization({
      ...unsigned,
      next_selection: selection(499)
    });

    expect(() => longMemEvalExpansionCapabilityData(
      modified as unknown as LongMemEvalExpansionCapability
    )).toThrow(/not live-verified/u);
  });

  it("rejects a self-hashed receipt whose product-default bundle differs", async () => {
    const fixture = expansionFixture();
    const { authorization_sha256: _digest, ...unsigned } = fixture.authorization;
    const modified = buildLongMemEvalMatrixPromotionAuthorization({
      ...unsigned,
      product_default: {
        ...unsigned.product_default,
        bundle_sha256: "9".repeat(64)
      }
    });

    await expect(verifyLongMemEvalExpansionCapability(fixture.input, {
      ...fixture.dependencies,
      authorize: async () => modified
    })).rejects.toThrow(/authorization differs from frozen matrix contract/u);
  });

  it("rejects validator identity drift after matrix verification", async () => {
    const fixture = expansionFixture();
    const dependencies: LongMemEvalExpansionCapabilityDependencies = {
      ...fixture.dependencies,
      computeExecutedDistIdentity: async () => ({
        ...fixture.contract.code.executed_dist,
        sha256: "0".repeat(64)
      })
    };

    await expect(verifyLongMemEvalExpansionCapability(
      fixture.input,
      dependencies
    )).rejects.toThrow(/validator identity drifted/u);
  });

  it("rejects a contract path whose live digest changed after descriptor read", async () => {
    const fixture = expansionFixture();
    const dependencies: LongMemEvalExpansionCapabilityDependencies = {
      ...fixture.dependencies,
      readContractSha256: async () => "0".repeat(64)
    };

    await expect(verifyLongMemEvalExpansionCapability(
      fixture.input,
      dependencies
    )).rejects.toThrow(/contract digest/u);
  });

  it("accepts a contract whose observational matrix entries are permuted", async () => {
    const fixture = expansionFixture([2, 0, 3, 1]);
    await expect(verifyLongMemEvalExpansionCapability(
      fixture.input,
      fixture.dependencies
    )).resolves.toBeDefined();
  });

  it("rejects a four-entry contract with a duplicate and missing treatment cell", () => {
    expect(() => expansionFixture([0, 1, 1, 3])).toThrow(/Cartesian product|unique/u);
  });
});

function expansionFixture(order: readonly number[] = [0, 1, 2, 3]) {
  const entries = [
    entry(false, false, "cell-a"),
    entry(true, false, "cell-b"),
    entry(false, true, "cell-c"),
    entry(true, true, "cell-d")
  ];
  const contract = LongMemEvalMatrixPromotionContractSchema.parse({
    schema_version: 2,
    kind: "longmemeval_matrix_promotion_contract",
    policy_version: "longmemeval-product-default-v1",
    code: {
      commit_sha: "abcdef0" + "1".repeat(33),
      commit_sha7: "abcdef0",
      worktree_state_sha256: "b".repeat(64),
      executed_dist: {
        algorithm: "sha256-reachable-path-file-sha256-v1",
        sha256: "8".repeat(64),
        file_count: 42
      }
    },
    dataset: { variant: "longmemeval_s" },
    selection: {
      policy_version: "dataset-prefix-full-snapshot-v1",
      source_prefix_count: 100,
      target_full_count: 500
    },
    snapshot: {
      db_path: "snapshot/source-100.db",
      manifest_sha256: "f".repeat(64)
    },
    execution_order: ["A", "B", "C", "D"],
    matrix: { entries: order.map((index) => entries[index]!) },
    absolute_quality_policy: expansionAbsoluteQualityPolicyFixture(),
    material_effect_policy: expansionMaterialEffectPolicyFixture()
  });
  const contractContents = Buffer.from(JSON.stringify(contract), "utf8");
  const parsed = parseLongMemEvalMatrixPromotionContract(contractContents);
  const sourceSelection = selection(100);
  const nextSelection = selection(500);
  const cells = contract.matrix.entries.map((matrixEntry, index) => ({
    cell: matrixCellForTreatment(matrixEntry.treatment),
    treatment: matrixEntry.treatment,
    evidence_root: matrixEntry.evidence_root,
    bundle_sha256: String(index + 1).repeat(64)
  })).sort((left, right) => left.cell.localeCompare(right.cell));
  const productCell = cells.find((cell) => cell.cell === "B")!;
  const validator = expansionValidatorFixture(contract.code);
  const authorization = buildLongMemEvalMatrixPromotionAuthorization({
    schema_version: 1,
    kind: "longmemeval_matrix_promotion_authorization",
    status: "authorized",
    contract_sha256: parsed.sha256,
    policy_version: contract.policy_version,
    source_selection: sourceSelection,
    next_selection: nextSelection,
    matrix: { sha256: sha256(JSON.stringify(cells)), cells },
    product_default: {
      cell: "B",
      treatment: productCell.treatment,
      bundle_sha256: productCell.bundle_sha256
    },
    hard_gates: [hardGate()],
    material_effect: expansionMaterialEffectFixture(),
    validator
  });
  const sourceSnapshot = snapshotAuthority();
  const input = {
    checkoutRoot: "/repo",
    contractPath: "/evidence/matrix.json",
    contractRoot: "/evidence",
    contractContents
  };
  const dependencies: LongMemEvalExpansionCapabilityDependencies = {
    authorize: async () => authorization,
    readSourceSnapshotAuthority: async () => sourceSnapshot,
    measureValidatorGitState: async () => ({
      commitSha: contract.code.commit_sha,
      commitSha7: contract.code.commit_sha7,
      worktreeStateSha256: contract.code.worktree_state_sha256,
      worktreeClean: true
    }),
    readContractSha256: async () => parsed.sha256,
    computeExecutedDistIdentity: async () => contract.code.executed_dist
  };
  return {
    input, dependencies, contract, parsed, authorization, sourceSnapshot
  };
}

function snapshotAuthority(): LongMemEvalSourceSnapshotAuthority {
  return {
    dbPath: "snapshot/source-100.db",
    manifestSha256: "f".repeat(64),
    dbSha256: "d".repeat(64),
    sidecarSha256: "e".repeat(64),
    extractionCache: {
      manifestSha256: "a".repeat(64),
      extractionModel: "gpt-5.4-mini",
      modelFamily: "gpt-5.4-mini",
      requestProfile: "provider-default-v1",
      providerUrl: `sha256:${"b".repeat(64)}`,
      systemPromptSha256: "1".repeat(64),
      cacheKeyAlgo: "sha256_model_profile_system_prompt_turn_v3",
      dataset: "longmemeval_s",
      datasetRevision: "d".repeat(64),
      windowOffset: 0,
      windowLimit: 100,
      expectedTurns: 23_807,
      expectedKeySetSha256: "7".repeat(64),
      contentClosureSha256: "9".repeat(64)
    }
  };
}

function selection(count: number) {
  return createLongMemEvalSelectionContractIdentity({
    datasetSha256: "d".repeat(64),
    assignments: Array.from({ length: count }, (_, index) => ({
      question_id: `question-${index + 1}`,
      dataset_cohort: index % 17 === 0 ? "abstention" as const : "answerable" as const
    }))
  });
}

function entry(bi: boolean, cross: boolean, evidenceRoot: string) {
  return {
    treatment: { embedding_supplement: bi, answer_rerank: cross },
    evidence_root: evidenceRoot
  };
}

function hardGate() {
  return {
    id: "longmemeval_s_100_embedding_on_r_at_5",
    label: "R@5",
    current: 0.91,
    target: 0.9,
    direction: "min" as const,
    unit: "ratio" as const,
    passed: true as const,
    missing: false as const
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
