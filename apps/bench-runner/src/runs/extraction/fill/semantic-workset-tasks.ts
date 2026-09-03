import { createHash } from "node:crypto";
import {
  OFFICIAL_API_SYSTEM_PROMPT,
  planOfficialApiSemanticWorkset
} from "@do-soul/alaya-soul";
import { computeExtractionTurnCacheKeys } from "../../compile-seed/compile-seed-cache.js";
import type { LongMemEvalExtractionTurn } from "../turn-contents.js";
import type { PreparedExtractionFill } from "./fill-preparation.js";
import type { SemanticFillTask } from "./semantic-fill-executor.js";
import {
  assertDemandKeysAreSubstrateMembers,
  buildSemanticSubstrateManifestAuthority
} from "./semantic-fill-authority.js";
import { resolveExtractionTransportRoute } from "../transport-route.js";

export function collectSemanticFillTasks(
  turns: readonly LongMemEvalExtractionTurn[],
  prepared: PreparedExtractionFill
): readonly SemanticFillTask[] {
  const transportRoute = resolveExtractionTransportRoute(prepared.config);
  const providerUrlSha256 = createHash("sha256")
    .update(transportRoute.providerUrl, "utf8")
    .digest("hex");
  const tasks: SemanticFillTask[] = [];
  if (prepared.existingManifest === undefined) {
    throw new Error("semantic fill lost its F0-F2 substrate manifest");
  }
  const substrateManifest = buildSemanticSubstrateManifestAuthority({
    manifest: prepared.existingManifest,
    manifestSha256: prepared.pinnedManifestSha256
  });
  for (const turn of turns) {
    const workset = planOfficialApiSemanticWorkset(
      turn.turnContent,
      turn.turnMessages,
      prepared.datasetRevision
    );
    const substrateCacheKeys = computeExtractionTurnCacheKeys(
      prepared.config.model,
      prepared.config.requestProfile,
      OFFICIAL_API_SYSTEM_PROMPT,
      turn
    );
    assertDemandKeysAreSubstrateMembers(
      substrateCacheKeys,
      Object.keys(prepared.existingManifest.content_closure_index ?? {})
    );
    for (const unit of workset.units) {
      tasks.push({
        semanticKey: unit.semanticKey,
        capability: "official_api_signals:v1",
        semanticContract: unit.semanticIdentity.contractId,
        modelFamily: prepared.config.modelFamily ?? prepared.config.model,
        modelId: prepared.config.model,
        transportModelId: transportRoute.model,
        requestProfile: prepared.config.requestProfile,
        providerUrlSha256,
        assertionId: unit.assertionId,
        text: unit.text,
        sourceCorpus: unit.sourceCorpus,
        semanticIdentity: unit.semanticIdentity,
        binding: unit.binding,
        sourceAuthority: {
          datasetRevision: prepared.datasetRevision,
          substrateManifest,
          substrateCacheKeys
        }
      });
    }
  }
  return tasks;
}
