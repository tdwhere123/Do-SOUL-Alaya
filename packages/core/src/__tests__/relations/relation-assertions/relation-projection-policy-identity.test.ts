import { afterEach, describe, expect, it } from "vitest";
import { initDatabase, type StorageDatabase } from "@do-soul/alaya-storage";
import { buildRelationProjection } from "../../../relations/relation-assertions/relation-projection-builder.js";

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("temporal relation projection policy identity", () => {
  it("writes the same live digest the builder emits", () => {
    const database = initDatabase({ filename: ":memory:" });
    databases.add(database);
    const written = database.connection.prepare(`
      SELECT assertion_schema_generation, assertion_event_contract_generation,
             projection_schema_generation, projection_policy_sha256
      FROM temporal_schema_state WHERE state_id = 1
    `).get() as {
      readonly assertion_schema_generation: string;
      readonly assertion_event_contract_generation: string;
      readonly projection_schema_generation: string;
      readonly projection_policy_sha256: string;
    };
    const builder = buildRelationProjection([], [], "1970-01-01T00:00:00.000Z", new Set());

    expect(written.projection_policy_sha256).toBe(builder.generation.projectionPolicySha256);
    expect(written.assertion_schema_generation).toBe(builder.generation.assertionSchemaGeneration);
    expect(written.assertion_event_contract_generation)
      .toBe(builder.generation.assertionEventContractGeneration);
    expect(written.projection_schema_generation).toBe(builder.generation.projectionSchemaGeneration);
  });
});
