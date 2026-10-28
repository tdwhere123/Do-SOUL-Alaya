import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { AlayaError } from "@do-soul/alaya-protocol";

export function recallExecutionIdentity(values, execution, revision, chainIdentity) {
  const explicit = ["model", "model-cache", "model-artifact-digest", "source-model", "source-cache", "source-artifact-digest"]
    .some(name => values[name] !== undefined) || values["warm-memory"] === true;
  return explicit ? chainIdentity({ revision, execution }) : undefined;
}

export function recallPreparationKey(revision, executionIdentity, execution, arm) {
  return createHash("sha256").update(JSON.stringify([revision, executionIdentity ?? execution.model_id,
    arm.host !== false, arm.windowing ?? null, arm.lexical ?? null, ...(arm.representation ? [arm.representation] : [])])).digest("hex").slice(0, 16);
}

export function assertRecallCachedPreparation(config, revision, execution, arm) {
  const actual = config.source_index;
  const expected = { ...execution, ...(arm.windowing ? { windowing: arm.windowing } : {}),
    ...(arm.lexical ? { lexical: arm.lexical } : {}), ...(arm.representation ? { representation: arm.representation } : {}) };
  const fields = ["cache_root", "model_id", "source_scope", "artifact_digest", "memory", "memory_warmup", "representation", "lexical"];
  if (config.implementation_revision !== revision || !actual ||
      fields.some(field => !isDeepStrictEqual(actual[field], expected[field])) ||
      expected.windowing !== undefined && actual.windowing !== expected.windowing) {
    throw new AlayaError("CONFLICT", "cached Source preparation uses a different execution selection");
  }
}
