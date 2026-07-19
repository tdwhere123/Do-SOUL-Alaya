import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expansionPromotionContractFixture } from
  "../../expansion/expansion-promotion-contract-fixture.js";
import {
  parseLongMemEvalMatrixPromotionContract
} from "../../../../longmemeval/promotion/schema/contract.js";

const collaborators = vi.hoisted(() => ({
  authorizeVerified: vi.fn(() => ({ status: "authorized" })),
  classifyCohort: vi.fn(() => "answerable"),
  loadDataset: vi.fn(),
  verifyEntry: vi.fn(async () => ({})),
  verifySnapshot: vi.fn(async () => ({}))
}));

vi.mock("../../../../longmemeval/ingestion/fetch.js", () => ({
  loadDatasetWithIdentity: collaborators.loadDataset
}));
vi.mock("../../../../longmemeval/selection/dataset-cohort.js", () => ({
  classifyLongMemEvalDatasetCohort: collaborators.classifyCohort
}));
vi.mock("../../../../longmemeval/promotion/schema/matrix-validator.js", () => ({
  authorizeVerifiedLongMemEvalMatrix: collaborators.authorizeVerified
}));
vi.mock("../../../../longmemeval/promotion/verifiers/entry-verifier.js", () => ({
  verifyRecallEvalPromotionEntry: collaborators.verifyEntry
}));
vi.mock("../../../../longmemeval/promotion/verifiers/snapshot-verifier.js", () => ({
  verifyPromotionSnapshot: collaborators.verifySnapshot
}));

import { authorizeLongMemEvalMatrixPromotion } from
  "../../../../longmemeval/promotion/index.js";

const roots: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("matrix authorize live code identity", () => {
  it("records executed-dist that differs from producer code", async () => {
    const fixture = await authorizeIdentityFixture();
    const driftedDist = {
      ...fixture.contract.code.executed_dist,
      sha256: "0".repeat(64)
    };
    await authorizeLongMemEvalMatrixPromotion(fixture.input, {
      ...fixture.dependencies,
      computeExecutedDistIdentity: async () => driftedDist
    });
    expect(collaborators.authorizeVerified).toHaveBeenCalledWith(
      expect.objectContaining({
        validator: expect.objectContaining({ executed_dist: driftedDist })
      })
    );
  });

  it("records git identity that differs from producer code", async () => {
    const fixture = await authorizeIdentityFixture();
    const driftedSha = "0".repeat(40);
    await authorizeLongMemEvalMatrixPromotion(fixture.input, {
      ...fixture.dependencies,
      measureValidatorGitState: async () => ({
        commitSha: driftedSha,
        commitSha7: "0000000",
        worktreeStateSha256: fixture.contract.code.worktree_state_sha256,
        worktreeClean: true
      })
    });
    expect(collaborators.authorizeVerified).toHaveBeenCalledWith(
      expect.objectContaining({
        validator: expect.objectContaining({
          commit_sha: driftedSha,
          commit_sha7: "0000000"
        })
      })
    );
  });

  it("records a dirty validator worktree without requiring producer equality", async () => {
    const fixture = await authorizeIdentityFixture();
    const dirtyState = "c".repeat(64);
    await authorizeLongMemEvalMatrixPromotion(fixture.input, {
      ...fixture.dependencies,
      measureValidatorGitState: async () => ({
        commitSha: fixture.contract.code.commit_sha,
        commitSha7: fixture.contract.code.commit_sha7,
        worktreeStateSha256: dirtyState,
        worktreeClean: false
      })
    });
    expect(collaborators.authorizeVerified).toHaveBeenCalledWith(
      expect.objectContaining({
        validator: expect.objectContaining({
          worktree_clean: false,
          worktree_state_sha256: dirtyState
        })
      })
    );
  });

  it("rejects a contract path whose live digest changed after descriptor read", async () => {
    const fixture = await authorizeIdentityFixture();
    await expect(authorizeLongMemEvalMatrixPromotion(fixture.input, {
      ...fixture.dependencies,
      readContractSha256: async () => "0".repeat(64)
    })).rejects.toThrow(/contract digest/u);
    expect(collaborators.verifySnapshot).not.toHaveBeenCalled();
  });

  it("rejects validator identity drift after evidence verification", async () => {
    const fixture = await authorizeIdentityFixture();
    const measure = vi.fn()
      .mockResolvedValueOnce({
        commitSha: fixture.contract.code.commit_sha,
        commitSha7: fixture.contract.code.commit_sha7,
        worktreeStateSha256: fixture.contract.code.worktree_state_sha256,
        worktreeClean: true
      })
      .mockResolvedValueOnce({
        commitSha: "0".repeat(40),
        commitSha7: "0000000",
        worktreeStateSha256: fixture.contract.code.worktree_state_sha256,
        worktreeClean: true
      });

    await expect(authorizeLongMemEvalMatrixPromotion(fixture.input, {
      ...fixture.dependencies,
      measureValidatorGitState: measure
    })).rejects.toThrow(/validator identity drifted/u);

    expect(collaborators.verifySnapshot).toHaveBeenCalledOnce();
    expect(collaborators.verifyEntry).toHaveBeenCalledTimes(4);
    expect(measure).toHaveBeenCalledTimes(2);
    expect(collaborators.authorizeVerified).not.toHaveBeenCalled();
  });
});

async function authorizeIdentityFixture() {
  const root = await mkdtemp(join(tmpdir(), "matrix-authorize-identity-"));
  roots.push(root);
  await Promise.all(["cell-a", "cell-b", "cell-c", "cell-d"].map((name) =>
    mkdir(join(root, name))
  ));
  const contract = expansionPromotionContractFixture();
  const contractContents = Buffer.from(JSON.stringify(contract), "utf8");
  const parsed = parseLongMemEvalMatrixPromotionContract(contractContents);
  const input = {
    checkoutRoot: "/repo",
    contractPath: join(root, "matrix.json"),
    contractRoot: root,
    contractContents
  };
  collaborators.loadDataset.mockResolvedValue({
    promotionAuthority: {},
    sha256: "a".repeat(64),
    questions: Array.from({ length: 500 }, (_, index) => ({
      question_id: `question-${index + 1}`
    }))
  });
  return {
    contract,
    input,
    dependencies: {
      measureValidatorGitState: async () => ({
        commitSha: contract.code.commit_sha,
        commitSha7: contract.code.commit_sha7,
        worktreeStateSha256: contract.code.worktree_state_sha256,
        worktreeClean: true
      }),
      readContractSha256: async () => parsed.sha256,
      computeExecutedDistIdentity: async () => contract.code.executed_dist
    }
  };
}
