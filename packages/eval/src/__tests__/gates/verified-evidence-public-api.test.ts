import { expect, it } from "vitest";
import * as publicApi from "../../index.js";
import type { VerifiedLongMemEvalEvidenceContext } from
  "../../gates/longmemeval-verified-evidence.js";
import { releaseHardGateAllowsLatestPassing } from
  "../../gates/release-gates.js";
import { buildReleaseGradePublic, makeSeedExtractionPath } from
  "./release-gates-fixture.js";

it("does not expose an object-only LongMemEval evidence capability mint", () => {
  expect(publicApi).not.toHaveProperty("verifyLongMemEvalReleaseEvidence");
  expect(publicApi).not.toHaveProperty("loadLongMemEvalReleaseEvidence");
  expect(publicApi).not.toHaveProperty("loadLongMemEvalReleaseEvidenceFromAuthority");
  expect(publicApi).not.toHaveProperty("createLongMemEvalReleaseEvidenceAuthority");

  const payload = buildReleaseGradePublic(makeSeedExtractionPath());
  const forgedContext = {
    datasetSha256: payload.dataset.checksum_sha256,
    selection: payload.selection_contract
  } as unknown as VerifiedLongMemEvalEvidenceContext;

  expect(releaseHardGateAllowsLatestPassing(payload, forgedContext)).toBe(false);
});
