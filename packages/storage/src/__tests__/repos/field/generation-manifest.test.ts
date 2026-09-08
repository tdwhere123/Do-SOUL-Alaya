import { afterEach, describe, expect, it } from "vitest";
import {
  CONDITIONAL_FIELD_GENERATION_OPERATOR_ID,
  CONDITIONAL_FIELD_OPERATOR_MANIFEST,
  conditionalFieldOperatorManifestDigest,
  hashGenerationId,
  verifyFieldProjectionGeneration
} from "@do-soul/alaya-protocol";
import { SqliteFieldProjectionGenerationRepo } from "../../../repos/field/generation-repo.js";
import { generationFromRow } from "../../../repos/field/mappers/field-receipts.js";
import { fieldSha256, hashedGeneration, openFieldDatabase } from "./field-contract-fixture.js";
import type { StorageDatabase } from "../../../sqlite/db.js";

const opened: StorageDatabase[] = [];
afterEach(() => { for (const database of opened) database.close(); opened.length = 0; });

function currentRow() {
  const base = hashedGeneration("workspace-1", "same-source", "shadow");
  const digest = conditionalFieldOperatorManifestDigest(fieldSha256);
  return {
    ...base,
    generation_id: hashGenerationId({
      operators: CONDITIONAL_FIELD_OPERATOR_MANIFEST, operator_manifest_digest: digest,
      field_schema_version: base.schema_version,
      input_event_frontier: base.input_event_frontier, governance_frontier: base.governance_frontier
    }, fieldSha256),
    operator_manifest_digest: digest,
    operator_versions_json: JSON.stringify(CONDITIONAL_FIELD_OPERATOR_MANIFEST.map(({ id, version }) => [id, version]))
  };
}

describe("persisted known generation manifests", () => {
  it("reads old rows unchanged and reconstructs current producer identity from its exact manifest", () => {
    const database = openFieldDatabase(); opened.push(database);
    const repo = new SqliteFieldProjectionGenerationRepo(database, fieldSha256);
    const old = repo.insert(hashedGeneration("workspace-1", "same-source", "shadow"));
    const current = repo.insert(currentRow());
    expect(current.generation_id).not.toBe(old.generation_id);
    expect(repo.readPinned("workspace-1", old.generation_id)).toEqual(old);
    const historical = generationFromRow(old);
    expect(historical.consumer).toBe("activation");
    expect(verifyFieldProjectionGeneration(historical, fieldSha256)).toEqual(historical);
    const restored = generationFromRow(repo.readPinned("workspace-1", current.generation_id)!);
    expect(restored.producer).toBe(CONDITIONAL_FIELD_GENERATION_OPERATOR_ID);
    expect(restored.consumer).toBe("conditional_field_snapshot");
    expect(verifyFieldProjectionGeneration(restored, fieldSha256)).toEqual(restored);
  });

  it("fails closed when a persisted manifest is tampered after admission", () => {
    const database = openFieldDatabase(); opened.push(database);
    const repo = new SqliteFieldProjectionGenerationRepo(database, fieldSha256);
    const current = repo.insert(currentRow());
    database.connection.prepare("UPDATE projection_generations SET operator_versions_json = ? WHERE generation_id = ?")
      .run(JSON.stringify([["unknown_operator", "1"]]), current.generation_id);
    expect(() => repo.readPinned("workspace-1", current.generation_id)).toThrow(/operator list drift/);
  });
});
