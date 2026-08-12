import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  MATERIALIZATION_COMMIT_NAME,
  MATERIALIZATION_JOURNAL_NAME,
  buildMaterializationCommit,
  buildMaterializationJournal,
  digest,
  readMaterializationCommit
} from "../../../../longmemeval/extraction/cache-audit/materialization/contract.js";
import {
  cleanupMaterializerFixtures,
  createMaterializerFixture,
  materialize
} from "../materializer-fixture.js";

afterEach(cleanupMaterializerFixtures);

it("rejects a recomputed commit whose journal digest was mutated", () => {
  const fixture = createMaterializerFixture();
  materialize(fixture);
  expect(existsSync(join(fixture.targetRoot, MATERIALIZATION_JOURNAL_NAME))).toBe(false);
  const path = join(fixture.targetRoot, MATERIALIZATION_COMMIT_NAME);
  const commit = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  commit.journal_digest = "9".repeat(64);
  delete commit.commit_digest;
  commit.commit_digest = digest(JSON.stringify(commit));
  writeFileSync(path, `${JSON.stringify(commit, null, 2)}\n`, "utf8");

  expect(() => materialize(fixture)).toThrow(/journal.*digest|commit.*journal/iu);
});

it("rejects a self-consistent commit above the persisted 128 KiB ceiling", () => {
  const fixture = createMaterializerFixture();
  materialize(fixture);
  const path = join(fixture.targetRoot, MATERIALIZATION_COMMIT_NAME);
  const persisted = readMaterializationCommit(path);
  const {
    schema_version: _schema, kind: _kind, state: _state,
    operation_id: _operation, created_at: createdAt, committed_at: committedAt,
    journal_digest: _journal, target_manifest_sha256: targetManifestSha256,
    commit_digest: _commit, ...binding
  } = persisted;
  const journal = buildMaterializationJournal({
    binding: { ...binding, max_shard_bytes: 128 * 1024 + 1 }, createdAt
  });
  const commit = buildMaterializationCommit({ journal, committedAt, targetManifestSha256 });
  writeFileSync(path, `${JSON.stringify(commit, null, 2)}\n`, "utf8");

  expect(() => materialize(fixture)).toThrow(/materialization binding|128 KiB/iu);
});
