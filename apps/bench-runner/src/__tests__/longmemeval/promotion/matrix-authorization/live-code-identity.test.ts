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
  it("rejects current executed-dist drift before verifying evidence", async () => {
    const fixture = await authorizeIdentityFixture();
    await expect(authorizeLongMemEvalMatrixPromotion(fixture.input, {
      ...fixture.dependencies,
      computeExecutedDistIdentity: async () => ({
        ...fixture.contract.code.executed_dist,
        sha256: "0".repeat(64)
      })
    })).rejects.toThrow(/executed dist/u);
    expect(collaborators.verifySnapshot).not.toHaveBeenCalled();
  });

  it("rejects current git identity drift before verifying evidence", async () => {
    const fixture = await authorizeIdentityFixture();
    await expect(authorizeLongMemEvalMatrixPromotion(fixture.input, {
      ...fixture.dependencies,
      resolveFrozenCodeIdentity: async () => ({
        ...fixture.frozen,
        commitSha: "0".repeat(40),
        commitSha7: "0000000"
      })
    })).rejects.toThrow(/git identity/u);
    expect(collaborators.verifySnapshot).not.toHaveBeenCalled();
  });

  it("rejects a null frozen identity before verifying evidence", async () => {
    const fixture = await authorizeIdentityFixture();
    await expect(authorizeLongMemEvalMatrixPromotion(fixture.input, {
      ...fixture.dependencies,
      resolveFrozenCodeIdentity: async () => null
    })).rejects.toThrow(/did not verify current code/u);
    expect(collaborators.verifySnapshot).not.toHaveBeenCalled();
  });

  it("rejects a contract path whose live digest changed after descriptor read", async () => {
    const fixture = await authorizeIdentityFixture();
    await expect(authorizeLongMemEvalMatrixPromotion(fixture.input, {
      ...fixture.dependencies,
      resolveFrozenCodeIdentity: async () => ({
        ...fixture.frozen,
        gateSha256: "0".repeat(64)
      })
    })).rejects.toThrow(/contract digest/u);
    expect(collaborators.verifySnapshot).not.toHaveBeenCalled();
  });

  it("rejects code drift after all evidence was verified but before authorization", async () => {
    const fixture = await authorizeIdentityFixture();
    const resolveIdentity = vi.fn()
      .mockResolvedValueOnce(fixture.frozen)
      .mockResolvedValueOnce({ ...fixture.frozen, commitSha: "0".repeat(40) });

    await expect(authorizeLongMemEvalMatrixPromotion(fixture.input, {
      ...fixture.dependencies,
      resolveFrozenCodeIdentity: resolveIdentity
    })).rejects.toThrow(/git identity/u);

    expect(collaborators.verifySnapshot).toHaveBeenCalledOnce();
    expect(collaborators.verifyEntry).toHaveBeenCalledTimes(5);
    expect(resolveIdentity).toHaveBeenCalledTimes(2);
    expect(collaborators.authorizeVerified).not.toHaveBeenCalled();
  });
});

async function authorizeIdentityFixture() {
  const root = await mkdtemp(join(tmpdir(), "matrix-authorize-identity-"));
  roots.push(root);
  await Promise.all(["cell-a", "cell-b", "cell-c", "cell-d", "cell-b2"].map((name) =>
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
  const frozen = {
    commitSha: contract.code.commit_sha,
    commitSha7: contract.code.commit_sha7,
    gateContractPath: input.contractPath,
    gateSha256: parsed.sha256,
    worktreeStateSha256: contract.code.worktree_state_sha256,
    worktreeClean: true as const
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
    frozen,
    dependencies: {
      resolveFrozenCodeIdentity: async () => frozen,
      computeExecutedDistIdentity: async () => contract.code.executed_dist
    }
  };
}
