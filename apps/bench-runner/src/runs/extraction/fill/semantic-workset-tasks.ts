import { createHash } from "node:crypto";
import { planOfficialApiSemanticWorkset } from "@do-soul/alaya-soul";
import type { LongMemEvalExtractionTurn } from "../turn-contents.js";
import type { PreparedExtractionFill } from "./fill-preparation.js";
import type { SemanticFillTask } from "./semantic-fill-executor.js";

export function collectSemanticFillTasks(
  turns: readonly LongMemEvalExtractionTurn[],
  prepared: PreparedExtractionFill
): readonly SemanticFillTask[] {
  const providerUrlSha256 = createHash("sha256")
    .update(prepared.config.providerUrl ?? "", "utf8")
    .digest("hex");
  const tasks: SemanticFillTask[] = [];
  for (const turn of turns) {
    const workset = planOfficialApiSemanticWorkset(
      turn.turnContent,
      turn.turnMessages,
      prepared.datasetRevision
    );
    for (const unit of workset.units) {
      tasks.push({
        semanticKey: unit.semanticKey,
        capability: "official_api_signals:v1",
        semanticContract: "alaya.assertion_semantic_identity.v1",
        modelFamily: prepared.config.modelFamily ?? prepared.config.model,
        modelId: prepared.config.model,
        requestProfile: prepared.config.requestProfile,
        providerUrlSha256,
        assertionId: unit.assertionId,
        text: unit.text,
        binding: unit.binding
      });
    }
  }
  return tasks;
}
