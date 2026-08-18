import { afterEach, describe, expect, it } from "vitest";
import { EMPTY_RELATION_HISTORY_DIGEST } from "@do-soul/alaya-protocol";
import {
  StorageError,
  SqliteRelationAssertionRepo,
  SqliteTemporalPathProjectionReader,
  TemporalProjectionGenerationMissingError,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import {
  TEMPORAL_VERIFIED_BIND_KEY_INDEX,
  migrateVerifiedProjectionBindKey
} from "../../../sqlite/temporal-verified-bind-key.js";
import {
  createRepo,
  trackedDatabases
} from "./path-relation-repo-fixture.js";

const WRONG_HISTORY_DIGEST = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HISTORICAL_AS_OF = "2026-07-16T01:30:00.000Z";
const DUPLICATE_AS_OF = "2026-07-15T01:30:00.000Z";
const WRONG_AS_OF = "2026-07-14T01:30:00.000Z";

afterEach(() => {
  for (const database of trackedDatabases) {
    database.close();
  }
  trackedDatabases.clear();
});

describe("temporal projection history bind key", () => {
  it("rejects an activate=false witness that differs from schema before insert or prune", () => {
    const { database } = createRepo();
    const repo = new SqliteRelationAssertionRepo(database);
    repo.writeProjectionGenerationInCurrentTransaction(
      projectionGeneration("temporal-same-history-cache", EMPTY_RELATION_HISTORY_DIGEST, HISTORICAL_AS_OF),
      { activate: false }
    );
    const before = snapshotProjectionState(database);

    let thrown: unknown;
    try {
      repo.writeProjectionGenerationInCurrentTransaction(
        projectionGeneration("temporal-mismatch-witness", WRONG_HISTORY_DIGEST, HISTORICAL_AS_OF),
        { activate: false }
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(StorageError);
    expect((thrown as StorageError).code).toBe("CONFLICT");
    expect(snapshotProjectionState(database)).toEqual(before);
  });

  it("keeps a same-asOf wrong-history generation unreadable", async () => {
    const { database } = createRepo();
    insertVerifiedGeneration(database, {
      generation: "temporal-wrong-history",
      historyDigest: WRONG_HISTORY_DIGEST,
      asOf: WRONG_AS_OF
    });
    const reader = new SqliteTemporalPathProjectionReader(new SqliteRelationAssertionRepo(database));

    await expect(reader.findByWorkspace("workspace-1", { asOf: WRONG_AS_OF }))
      .rejects.toBeInstanceOf(TemporalProjectionGenerationMissingError);
    expect(generationExists(database, "temporal-wrong-history")).toBe(true);
  });

  it("fails closed when two verified generations share a bind key", async () => {
    const { database } = createRepo();
    dropVerifiedBindKeyUniqueIndex(database);
    insertVerifiedGeneration(database, {
      generation: "temporal-bind-key-a",
      historyDigest: EMPTY_RELATION_HISTORY_DIGEST,
      asOf: DUPLICATE_AS_OF
    });
    insertVerifiedGeneration(database, {
      generation: "temporal-bind-key-b",
      historyDigest: EMPTY_RELATION_HISTORY_DIGEST,
      asOf: DUPLICATE_AS_OF
    });

    const reader = new SqliteTemporalPathProjectionReader(new SqliteRelationAssertionRepo(database));
    await expect(reader.findByWorkspace("workspace-1", { asOf: DUPLICATE_AS_OF }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(countVerifiedBindKeys(database, DUPLICATE_AS_OF, EMPTY_RELATION_HISTORY_DIGEST)).toBe(2);
  });

  it("collapses compatible verified bind-key duplicates without rewriting the operator", () => {
    const { database } = createRepo();
    const before = snapshotProjectionState(database);
    dropVerifiedBindKeyUniqueIndex(database);
    insertVerifiedGeneration(database, {
      generation: "temporal-epoch-duplicate",
      historyDigest: EMPTY_RELATION_HISTORY_DIGEST,
      asOf: "1970-01-01T00:00:00.000Z"
    });

    migrateVerifiedProjectionBindKey(database.connection);

    expect(readVerifiedBindKeyGenerationIds(
      database,
      "1970-01-01T00:00:00.000Z",
      EMPTY_RELATION_HISTORY_DIGEST
    )).toEqual(["temporal-bootstrap-empty-v1"]);
    expect(snapshotProjectionState(database).schema).toEqual(before.schema);
    expect(readVerifiedBindKeyUniqueConstraintSql(database)).toEqual(expect.stringMatching(
      /UNIQUE[\s\S]*(as_of[\s\S]*history_digest|history_digest[\s\S]*as_of)/i
    ));
  });

  it("fails closed on incompatible verified bind-key duplicates", () => {
    const { database } = createRepo();
    const before = snapshotProjectionState(database);
    dropVerifiedBindKeyUniqueIndex(database);
    insertVerifiedGeneration(database, {
      generation: "temporal-incompatible-a",
      historyDigest: EMPTY_RELATION_HISTORY_DIGEST,
      asOf: DUPLICATE_AS_OF
    });
    database.connection.prepare(`
      INSERT INTO temporal_projection_generations (
        generation, assertion_schema_generation, assertion_event_contract_generation,
        projection_schema_generation, projection_policy_id, projection_policy_sha256,
        history_digest, as_of, projection_count, projection_digest, status,
        created_at, verified_at
      )
      SELECT ?, assertion_schema_generation, assertion_event_contract_generation,
        projection_schema_generation, projection_policy_id, projection_policy_sha256,
        ?, ?, 1, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        'verified', ?, ?
      FROM temporal_projection_generations
      WHERE generation = (
        SELECT active_projection_generation FROM temporal_schema_state WHERE state_id = 1
      )
    `).run(
      "temporal-incompatible-b",
      EMPTY_RELATION_HISTORY_DIGEST,
      DUPLICATE_AS_OF,
      DUPLICATE_AS_OF,
      DUPLICATE_AS_OF
    );

    expect(() => migrateVerifiedProjectionBindKey(database.connection)).toThrow(
      /Incompatible verified temporal projection bind-key duplicates/
    );
    expect(readSchemaOperator(database)).toEqual(before.schema);
    expect(countVerifiedBindKeys(database, DUPLICATE_AS_OF, EMPTY_RELATION_HISTORY_DIGEST)).toBe(2);
  });

  it("exposes a verified bind-key unique index that rejects a second insert", () => {
    const { database } = createRepo();
    expect(readVerifiedBindKeyUniqueConstraintSql(database)).toEqual(expect.stringMatching(
      /UNIQUE[\s\S]*(as_of[\s\S]*history_digest|history_digest[\s\S]*as_of)/i
    ));

    insertVerifiedGeneration(database, {
      generation: "temporal-bind-key-first",
      historyDigest: EMPTY_RELATION_HISTORY_DIGEST,
      asOf: DUPLICATE_AS_OF
    });
    expect(() => insertVerifiedGeneration(database, {
      generation: "temporal-bind-key-second",
      historyDigest: EMPTY_RELATION_HISTORY_DIGEST,
      asOf: DUPLICATE_AS_OF
    })).toThrow(/UNIQUE constraint failed/i);
  });

  it("rejects writer reuse of a zero-projection bind key when policy metadata differs", () => {
    const { database } = createRepo();
    const repo = new SqliteRelationAssertionRepo(database);
    const first = projectionGeneration(
      "temporal-zero-policy-a",
      EMPTY_RELATION_HISTORY_DIGEST,
      HISTORICAL_AS_OF
    );
    const mismatched = {
      ...first,
      generation: "temporal-zero-policy-b",
      projectionPolicyId: "relation-path-projection-v0"
    };
    repo.writeProjectionGenerationInCurrentTransaction(first, { activate: false });
    expect(mismatched.projectionDigest).toBe(first.projectionDigest);
    expect(first.projections).toEqual([]);
    expect(mismatched.projectionPolicyId).not.toBe(first.projectionPolicyId);

    let thrown: unknown;
    try {
      repo.writeProjectionGenerationInCurrentTransaction(mismatched, { activate: false });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(StorageError);
    expect((thrown as StorageError).code).toBe("CONFLICT");
    expect(generationExists(database, first.generation)).toBe(true);
    expect(generationExists(database, mismatched.generation)).toBe(false);
    expect(countVerifiedBindKeys(database, HISTORICAL_AS_OF, EMPTY_RELATION_HISTORY_DIGEST)).toBe(1);
  });

  it("fails closed collapsing zero-projection bind-key duplicates that differ only in policy metadata", () => {
    const { database } = createRepo();
    const before = snapshotProjectionState(database);
    dropVerifiedBindKeyUniqueIndex(database);
    insertVerifiedGeneration(database, {
      generation: "temporal-zero-policy-a",
      historyDigest: EMPTY_RELATION_HISTORY_DIGEST,
      asOf: DUPLICATE_AS_OF
    });
    insertVerifiedGeneration(database, {
      generation: "temporal-zero-policy-b",
      historyDigest: EMPTY_RELATION_HISTORY_DIGEST,
      asOf: DUPLICATE_AS_OF,
      projectionPolicyId: "relation-path-projection-v0"
    });
    expect(readGenerationIdentity(database, "temporal-zero-policy-a")).toMatchObject({
      projection_count: 0,
      projection_digest: readGenerationIdentity(database, "temporal-zero-policy-b").projection_digest,
      projection_policy_id: readGenerationIdentity(database, "temporal-bootstrap-empty-v1")
        .projection_policy_id
    });
    expect(readGenerationIdentity(database, "temporal-zero-policy-b").projection_policy_id)
      .toBe("relation-path-projection-v0");

    expect(() => migrateVerifiedProjectionBindKey(database.connection)).toThrow(
      /Incompatible verified temporal projection bind-key duplicates/
    );
    expect(readSchemaOperator(database)).toEqual(before.schema);
    expect(countVerifiedBindKeys(database, DUPLICATE_AS_OF, EMPTY_RELATION_HISTORY_DIGEST)).toBe(2);
  });
});

function projectionGeneration(generation: string, historyDigest: string, generationAsOf: string) {
  return {
    generation,
    assertionSchemaGeneration: "relation_assertion_v2",
    assertionEventContractGeneration: "relation_assertion_event_v2",
    projectionSchemaGeneration: "relation_path_projection_v1",
    projectionPolicyId: "relation-path-projection-v1",
    projectionPolicySha256: "f".repeat(64),
    historyDigest,
    asOf: generationAsOf,
    projectionDigest: generation.padEnd(64, "0").slice(0, 64),
    projections: [],
    createdAt: generationAsOf
  };
}

function insertVerifiedGeneration(
  database: StorageDatabase,
  input: Readonly<{
    readonly generation: string;
    readonly historyDigest: string;
    readonly asOf: string;
    readonly projectionPolicyId?: string;
  }>
): void {
  database.connection.prepare(`
    INSERT INTO temporal_projection_generations (
      generation, assertion_schema_generation, assertion_event_contract_generation,
      projection_schema_generation, projection_policy_id, projection_policy_sha256,
      history_digest, as_of, projection_count, projection_digest, status,
      created_at, verified_at
    )
    SELECT ?, assertion_schema_generation, assertion_event_contract_generation,
      projection_schema_generation, COALESCE(?, projection_policy_id), projection_policy_sha256,
      ?, ?, 0, projection_digest, 'verified', ?, ?
    FROM temporal_projection_generations
    WHERE generation = (
      SELECT active_projection_generation FROM temporal_schema_state WHERE state_id = 1
    )
  `).run(
    input.generation,
    input.projectionPolicyId ?? null,
    input.historyDigest,
    input.asOf,
    input.asOf,
    input.asOf
  );
}

function readGenerationIdentity(database: StorageDatabase, generation: string) {
  return database.connection.prepare(`
    SELECT projection_count, projection_digest, projection_policy_id
    FROM temporal_projection_generations
    WHERE generation = ?
  `).get(generation) as Readonly<{
    readonly projection_count: number;
    readonly projection_digest: string;
    readonly projection_policy_id: string;
  }>;
}

function snapshotProjectionState(database: StorageDatabase) {
  return {
    schema: database.connection.prepare(`
      SELECT active_projection_generation, active_as_of, history_digest, projection_count
      FROM temporal_schema_state
      WHERE state_id = 1
    `).get(),
    generations: database.connection.prepare(`
      SELECT generation, history_digest, as_of, status
      FROM temporal_projection_generations
      ORDER BY generation ASC
    `).all()
  };
}

function generationExists(database: StorageDatabase, generation: string): boolean {
  return database.connection.prepare(
    "SELECT 1 AS n FROM temporal_projection_generations WHERE generation = ?"
  ).get(generation) !== undefined;
}

function readVerifiedBindKeyUniqueConstraintSql(database: StorageDatabase): string | undefined {
  const rows = database.connection.prepare(`
    SELECT sql
    FROM sqlite_master
    WHERE tbl_name = 'temporal_projection_generations' AND sql IS NOT NULL
  `).all() as ReadonlyArray<{ readonly sql: string }>;
  return rows.map((row) => row.sql).find((sql) =>
    /unique/i.test(sql) && /as_of/i.test(sql) && /history_digest/i.test(sql)
  );
}

function dropVerifiedBindKeyUniqueIndex(database: StorageDatabase): void {
  database.connection.exec(`DROP INDEX IF EXISTS ${TEMPORAL_VERIFIED_BIND_KEY_INDEX}`);
}

function countVerifiedBindKeys(
  database: StorageDatabase,
  asOf: string,
  historyDigest: string
): number {
  const row = database.connection.prepare(`
    SELECT COUNT(*) AS n
    FROM temporal_projection_generations
    WHERE as_of = ? AND history_digest = ? AND status = 'verified'
  `).get(asOf, historyDigest) as { readonly n: number };
  return row.n;
}

function readVerifiedBindKeyGenerationIds(
  database: StorageDatabase,
  asOf: string,
  historyDigest: string
): readonly string[] {
  return (database.connection.prepare(`
    SELECT generation
    FROM temporal_projection_generations
    WHERE as_of = ? AND history_digest = ? AND status = 'verified'
    ORDER BY generation ASC
  `).all(asOf, historyDigest) as ReadonlyArray<{ readonly generation: string }>)
    .map((row) => row.generation);
}

function readSchemaOperator(database: StorageDatabase) {
  return database.connection.prepare(`
    SELECT active_projection_generation, active_as_of, history_digest, projection_count
    FROM temporal_schema_state
    WHERE state_id = 1
  `).get();
}
