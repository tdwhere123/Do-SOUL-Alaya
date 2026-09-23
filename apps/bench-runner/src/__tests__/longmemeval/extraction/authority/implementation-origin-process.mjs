import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const inspection = await import(pathToFileURL(process.env.IMPLEMENTATION_MODULE).href);
const receipts = await import(new URL("./receipt.js", pathToFileURL(process.env.IMPLEMENTATION_MODULE)));
const authority = await import(pathToFileURL(process.env.PROPOSAL_AUTHORITY_MODULE).href);
const revision = inspection.readCurrentExtractionAuthorityRevision();
const scope = authority.inspectSemanticProposalExecutionScope(process.env.PROPOSAL_OUTPUT_ROOT);
const observation = {
  revision, commandDigest: "e".repeat(64), selectionDigest: "f".repeat(64), keyDigest: "b".repeat(64),
  dataset: { variant: "longmemeval_s", revisionSha256: "a".repeat(64), windowOffset: 0, windowLimit: 1,
    windowTurnOccurrences: 1, windowUniqueCacheKeys: 1, authorizedQuestionCount: 1,
    authorizedTurnOccurrences: 1, authorizedUniqueCacheKeys: 1, expectedKeySetSha256: "b".repeat(64) },
  extraction: { model: "gpt-5.4-mini", modelFamily: "gpt-5.4-mini", requestProfile: "provider-default-v1",
    providerUrl: "https://example.test/v1", systemPromptSha256: "c".repeat(64),
    cacheKeyAlgorithm: "sha256(model\\0requestProfile\\0systemPrompt\\0turnContent)",
    manifestSha256: null, rawContentClosureSha256: null },
  inventory: { expectedTurns: 1, validTurns: 0, missingTurns: 1, invalidTurns: 0, orphanTurns: 0 }
};
const receiptInput = { action: "fill", observation, outputTokenCap: { field: "max_tokens", value: 512 },
  priceEstimate: { inputUsdPerMillion: 1, outputUsdPerMillion: 2, maximumInputTokensPerAttempt: 300 },
  diskFloorBytes: 0, inspection: { writerLock: "absent", disk: { status: "available", freeBytes: 1024 },
    credentialStatus: "present", modelReadiness: "not_probed" } };
const correctReceipt = receipts.createExtractionAuthorityReceipt(receiptInput);
const wrongReceipt = receipts.createExtractionAuthorityReceipt({ ...receiptInput,
  observation: { ...observation, revision: `git-worktree-v1:${"a".repeat(40)}:${"b".repeat(64)}` } });
let sourceWrongRejected = false;
receipts.assertExtractionAuthorityReceipt(correctReceipt, observation);
try { receipts.assertExtractionAuthorityReceipt(wrongReceipt, observation); }
catch { sourceWrongRejected = true; }
process.stdout.write(JSON.stringify({
  revision,
  scopeRevision: scope.implementation_revision,
  outputRootAbsent: !existsSync(process.env.PROPOSAL_OUTPUT_ROOT),
  sourceWrongRejected
}));
