import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { sourceDisclosure, SourceSemanticResourceExhausted, indexEntryCacheKey, SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET } from "@do-soul/alaya-protocol";
import { CoreError, createAuditedSourceAdmission, fieldContractSha256, sourceGoldRootIdentity } from "@do-soul/alaya-core";
import { closeCachedDatabase, SqliteEventLogRepo, type StorageDatabase } from "@do-soul/alaya-storage";
import { createDaemonFieldRepos } from "../../../runtime/field/field-repos.js";
import { createSqliteFieldFormationStores } from "../../../runtime/field/sqlite-field-formation-stores.js";
import { compareResearchOriginalSourceEvidence, type ResearchOriginalSourceEvidenceInput }
  from "../../../runtime/recall-read-worker/source-semantic-research-original-evidence.js";
import { deriveAddressableSpanViews } from "../../../../../../packages/core/src/memory/evidence-create/source-span-views.js";
import { createRecallRealStorage } from "../../../../../../packages/core/src/__tests__/shared/real-sqlite.test-support.js";
import { ACCESS_BUDGET, CLOCK, WS } from "./source-semantic-access.test-support.js";
import { OUTPUT_BYTE_LIMITS } from "./source-semantic-library-binding-coverage.js";

const ORIGINAL = "which tools does Alice use?";
const UNAVAILABLE = "cache_unavailable" as const;
const LONG_BODY = `User: ${"x".repeat(2480)}`;
const PREVIEW_BYTES = 1600;
const QUERY_UNAVAILABLE = { status: "unavailable" as const, reason: UNAVAILABLE };

type PublishedRecord = Readonly<{
  source_id: string; record_id: string; source_version: string; source_body: string; content_digest: string;
}>;

function twelveSources(twelfthBody = "User: source 12 body.") {
  return Array.from({ length: 12 }, (_, index) => ({
    id: `source-${String(index + 1).padStart(2, "0")}`,
    text: index === 11 ? twelfthBody : `User: source ${String(index + 1)} body.`
  }));
}

function observationsOf(records: readonly PublishedRecord[], readBytes?: ReadonlyMap<string, number>) {
  return records.map((record) => {
    const bodyBytes = Buffer.byteLength(record.source_body);
    const read = readBytes?.get(record.source_id) ?? bodyBytes;
    return {
      source_id: record.source_id, record_id: record.record_id, source_version: record.source_version,
      content_digest: record.content_digest, read_bytes: read, body_bytes: bodyBytes,
      complete: read === bodyBytes, signal: { source_text_score: null, interpretation_reading_score: 0 }
    };
  });
}

function evidenceInput(records: readonly PublishedRecord[], extra: {
  proposed_root_ids: readonly string[];
  observations?: ResearchOriginalSourceEvidenceInput["observations"];
  source_preview_extents?: ResearchOriginalSourceEvidenceInput["source_preview_extents"];
  output_byte_limit?: number;
  authorized_scopes?: ResearchOriginalSourceEvidenceInput["authorized_scopes"];
}): ResearchOriginalSourceEvidenceInput {
  return {
    workspace_id: WS, as_of: CLOCK,
    authorized_scopes: extra.authorized_scopes ?? { mode: "named", scopes: ["project"] },
    original_query: ORIGINAL, query_semantics_unavailable: UNAVAILABLE, budget: ACCESS_BUDGET,
    output_byte_limit: extra.output_byte_limit ?? OUTPUT_BYTE_LIMITS.schema_max,
    observations: extra.observations ?? observationsOf(records),
    ...(extra.source_preview_extents === undefined ? {} : { source_preview_extents: extra.source_preview_extents }),
    proposed_root_ids: extra.proposed_root_ids
  };
}

function utf8Prefix(text: string, bytes: number): string {
  return Buffer.from(text, "utf8").subarray(0, bytes).toString("utf8");
}

function entryRoot(entry: { target: { kind: string; root_id?: string } }): string {
  if (entry.target.kind !== "source_evidence" || entry.target.root_id === undefined) {
    throw new Error("encoded library entry must keep a source identity");
  }
  return entry.target.root_id;
}

function armIdentities(arm: ReturnType<typeof compareResearchOriginalSourceEvidence>["baseline"]) {
  return arm.result.index.entries.map((entry) => {
    if (entry.target.kind !== "source_evidence") throw new Error("original-source arm must occupy source evidence");
    return {
      root_id: entry.target.root_id, source_version: entry.target.source_version,
      content_digest: entry.target.content_digest, gold: sourceGoldRootIdentity(entry.target)
    };
  });
}

function armPreviews(arm: ReturnType<typeof compareResearchOriginalSourceEvidence>["baseline"]) {
  return arm.result.index.entries.map((entry) => arm.result.previews?.[indexEntryCacheKey(entry)] ?? null);
}

function encodedOriginals(arm: ReturnType<typeof compareResearchOriginalSourceEvidence>["baseline"]) {
  if (!("results" in arm.encoded) || !("index" in arm.encoded)) throw new Error("expected an encoded recall page");
  return arm.encoded;
}

function assertUnavailableOriginalArm(
  arm: ReturnType<typeof compareResearchOriginalSourceEvidence>["baseline"],
  records: readonly PublishedRecord[],
  expectedRootIds: readonly string[],
  previewOf: (record: PublishedRecord) => string
) {
  expect(arm.result.query_semantics_status).toEqual(QUERY_UNAVAILABLE);
  expect(arm.result.proofs).toBeUndefined();
  expect(arm.result.unproved_computations).toBeUndefined();
  expect(arm.result.index.entries).toHaveLength(expectedRootIds.length);
  expect(armIdentities(arm).map((row) => row.root_id)).toEqual([...expectedRootIds]);
  const stored = expectedRootIds.map((rootId) => {
    const record = records.find((row) => row.record_id === rootId);
    expect(record).toBeDefined();
    return record!;
  });
  for (const [index, identity] of armIdentities(arm).entries()) {
    const entry = arm.result.index.entries[index]!;
    expect(identity.source_version).toBe(stored[index]!.source_version);
    expect(identity.content_digest).toBe(stored[index]!.content_digest);
    if (entry.target.kind !== "source_evidence") throw new Error("original-source arm must occupy source evidence");
    expect(identity.gold).toBe(sourceGoldRootIdentity(entry.target));
  }
  expect(armPreviews(arm)).toEqual(stored.map(previewOf));
  expect(arm.encoded.operation).toBe("recall");
  const encoded = encodedOriginals(arm);
  expect(encoded.results?.map((row) => row.content_preview)).toEqual(stored.map(previewOf));
  expect(encoded.results?.map((row) => sourceDisclosure(row.source_disclosure!).proof_use)).toEqual(
    stored.map(() => ({ kind: "source_only", qualification: "not_current_proof" }))
  );
  expect(encoded.index?.entries.map(entryRoot)).toEqual([...expectedRootIds]);
}

async function withOriginalLibrary(
  sources: readonly Readonly<{ id: string; text: string; scope?: "project" | "global_core"; version?: string }>[],
  body: (input: { database: StorageDatabase; filename: string; records: readonly PublishedRecord[] }) => Promise<void>
) {
  const directory = await mkdtemp(join(tmpdir(), "research-original-evidence-"));
  const filename = join(directory, "alaya.db");
  const { database } = await createRecallRealStorage(() => undefined, filename);
  try {
    const admission = createAuditedSourceAdmission({
      stores: createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) }),
      eventLogRepo: new SqliteEventLogRepo(database), runtimeNotifier: { notifyEntry: async () => undefined },
      sha256: fieldContractSha256
    });
    for (const fixture of sources) {
      await admission.admit({
        workspace_id: WS, source_id: fixture.id, source_version: fixture.version ?? "1",
        content_bytes: fixture.text, evidence_object_id: null, recorded_at: CLOCK, event_time: null,
        valid_from: null, valid_to: null, speaker: "user", scope_class: fixture.scope ?? "project",
        spans: deriveAddressableSpanViews(fixture.text)
      }, { workspaceId: WS });
    }
    const persisted = database.connection.prepare(
      "SELECT source_id, record_id, source_version, source_body, content_digest FROM source_records ORDER BY source_id"
    ).all() as {
      source_id: string; record_id: string; source_version: string; source_body: string | null; content_digest: string;
    }[];
    expect(persisted.length).toBeGreaterThanOrEqual(12);
    const records = persisted.map((row) => {
      expect(typeof row.source_body).toBe("string");
      expect(row.source_body!.length).toBeGreaterThan(0);
      return {
        source_id: row.source_id, record_id: row.record_id, source_version: row.source_version,
        source_body: row.source_body!, content_digest: row.content_digest
      };
    });
    await body({ database, filename, records });
  } finally {
    database.close();
    closeCachedDatabase(filename);
    await rm(directory, { recursive: true, force: true });
  }
}

it("rejects a partially hydrated frozen pool even when the proposal is empty", async () => {
  await withOriginalLibrary(twelveSources(), async ({ database, records }) => {
    // Include streamed hash handoffs: hydrate/deliver one source, but not the complete twelve-source pool.
    const budget = { ...ACCESS_BUDGET, work_units: 3000 };
    const first = records[0]!.record_id;
    const small = compareResearchOriginalSourceEvidence(database, {
      ...evidenceInput(records.slice(0, 1), { proposed_root_ids: [first] }), budget
    });
    expect(armIdentities(small.proposed).map(row => row.root_id)).toEqual([first]);
    for (const proposedRootIds of [[], [first]]) {
      expect(() => compareResearchOriginalSourceEvidence(database, {
        ...evidenceInput(records, { proposed_root_ids: proposedRootIds }), budget
      })).toThrow(new SourceSemanticResourceExhausted("research frozen-pool preparation"));
    }
  });
}, 60_000);

it("encodes native first-five original sources against a proposed page that includes the twelfth root", async () => {
  await withOriginalLibrary(twelveSources(), async ({ database, records }) => {
    expect(records).toHaveLength(12);
    const firstFive = records.slice(0, SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET).map((row) => row.record_id);
    const proposedIds = [...records.slice(0, 4).map((row) => row.record_id), records[11]!.record_id];
    expect(proposedIds).toContain(records[11]!.record_id);
    expect(firstFive).not.toContain(records[11]!.record_id);
    const comparison = compareResearchOriginalSourceEvidence(database, evidenceInput(records, {
      proposed_root_ids: proposedIds
    }));
    expect(comparison.provenance).toBe("research_original_source_evidence");
    expect(comparison.query_semantics_status).toEqual(QUERY_UNAVAILABLE);
    assertUnavailableOriginalArm(comparison.baseline, records, firstFive, (record) => record.source_body);
    assertUnavailableOriginalArm(comparison.proposed, records, proposedIds, (record) => record.source_body);
    expect(armIdentities(comparison.proposed).map((row) => row.root_id)).not.toEqual(firstFive);
    expect(comparison.baseline.result.index.continuation).not.toBeNull();
    expect(comparison.proposed.result.index.continuation).toBeNull();
    expect(comparison.proposed.result.discovery.truncated).toBe(false);
  });
}, 60_000);

it("rejects a wrong root, version, or scope through the current source owner", async () => {
  await withOriginalLibrary([
    ...twelveSources(),
    { id: "source-13", text: "User: scoped out.", scope: "global_core" }
  ], async ({ database, records }) => {
    const pool = records.filter((row) => row.source_id !== "source-13");
    const proposed = pool.slice(0, SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET).map((row) => row.record_id);
    expect(() => compareResearchOriginalSourceEvidence(database, evidenceInput(pool, {
      proposed_root_ids: [...proposed.slice(0, 4), "missing-root"]
    }))).toThrow(CoreError);
    try {
      compareResearchOriginalSourceEvidence(database, evidenceInput(pool, {
        proposed_root_ids: [...proposed.slice(0, 4), "missing-root"]
      }));
      throw new Error("wrong proposed root must be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(CoreError);
      expect((error as CoreError).code).toBe("VALIDATION");
      expect((error as CoreError).message).toMatch(/proposed research root is not in the frozen source pool/u);
    }
    const versioned = observationsOf(pool).map((row, index) => index === 0
      ? { ...row, source_version: "2" } : row);
    try {
      compareResearchOriginalSourceEvidence(database, evidenceInput(pool, {
        proposed_root_ids: proposed, observations: versioned
      }));
      throw new Error("stale observation version must be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(CoreError);
      expect((error as CoreError).code).toBe("CONFLICT");
      expect((error as CoreError).message).toMatch(/not current in the source publication/u);
    }
    const outsider = records.find((row) => row.source_id === "source-13");
    expect(outsider).toBeDefined();
    try {
      compareResearchOriginalSourceEvidence(database, evidenceInput(records, {
        proposed_root_ids: [outsider!.record_id], observations: observationsOf([outsider!])
      }));
      throw new Error("out-of-scope source must be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(CoreError);
      expect((error as CoreError).code).toBe("VALIDATION");
      expect((error as CoreError).message).toMatch(/outside authorized scopes/u);
    }
  });
}, 60_000);

it("keeps a declared 1600-byte long-source preview exact through native fit", async () => {
  expect(Buffer.byteLength(LONG_BODY)).toBeGreaterThan(PREVIEW_BYTES);
  await withOriginalLibrary(twelveSources(LONG_BODY), async ({ database, records }) => {
    const long = records.find((row) => row.source_id === "source-12");
    expect(long).toBeDefined();
    expect(long!.source_body).toBe(LONG_BODY);
    const exact = utf8Prefix(LONG_BODY, PREVIEW_BYTES);
    expect(exact).toHaveLength(PREVIEW_BYTES);
    expect(LONG_BODY.startsWith(exact)).toBe(true);
    expect(exact).not.toBe(LONG_BODY);
    const wrongExtents = records.map(record => ({ source_id: record.source_id, source_version: record.source_version,
      record_id: record.record_id, byte_extent: record.source_id === long!.source_id
        ? PREVIEW_BYTES - 1 : Buffer.byteLength(record.source_body) }));
    expect(() => compareResearchOriginalSourceEvidence(database, evidenceInput(records, {
      proposed_root_ids: [long!.record_id], source_preview_extents: wrongExtents,
      observations: observationsOf(records, new Map(wrongExtents.map(row => [row.source_id, row.byte_extent])))
    }))).toThrow(/native preview differs from the frozen research extent/u);
    const extents = records.map((record) => ({
      source_id: record.source_id, source_version: record.source_version, record_id: record.record_id,
      byte_extent: record.source_id === "source-12" ? PREVIEW_BYTES : Buffer.byteLength(record.source_body)
    }));
    const readBytes = new Map(extents.map((row) => [row.source_id, row.byte_extent]));
    const proposedIds = [...records.slice(0, 4).map((row) => row.record_id), long!.record_id];
    const comparison = compareResearchOriginalSourceEvidence(database, evidenceInput(records, {
      proposed_root_ids: proposedIds, observations: observationsOf(records, readBytes),
      source_preview_extents: extents
    }));
    expect(comparison.query_semantics_status).toEqual(QUERY_UNAVAILABLE);
    const previewOf = (record: PublishedRecord) => record.source_id === "source-12"
      ? exact : record.source_body;
    assertUnavailableOriginalArm(comparison.proposed, records, proposedIds, previewOf);
    const delivered = comparison.proposed.result.index.entries.find((entry) =>
      entry.target.kind === "source_evidence" && entry.target.root_id === long!.record_id);
    expect(delivered).toBeDefined();
    expect(comparison.proposed.result.previews?.[indexEntryCacheKey(delivered!)]).toBe(exact);
    expect(encodedOriginals(comparison.proposed).results?.at(-1)?.content_preview).toBe(exact);
    expect(encodedOriginals(comparison.proposed).results?.at(-1)?.content_preview).not.toBe(LONG_BODY);
  });
}, 60_000);

it("fits an honest byte cap as a short page with continuation rather than a post-hoc cut", async () => {
  await withOriginalLibrary(twelveSources(), async ({ database, records }) => {
    const proposedIds = records.slice(0, SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET).map((row) => row.record_id);
    const full = compareResearchOriginalSourceEvidence(database, evidenceInput(records, {
      proposed_root_ids: proposedIds
    }));
    const fullBytes = Buffer.byteLength(JSON.stringify(full.baseline.encoded), "utf8");
    expect(full.baseline.result.index.entries).toHaveLength(SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET);
    const byteLimit = 10_000;
    expect(fullBytes).toBeGreaterThan(byteLimit);
    const capped = compareResearchOriginalSourceEvidence(database, evidenceInput(records, {
      proposed_root_ids: proposedIds, output_byte_limit: byteLimit
    }));
    expect(capped.query_semantics_status).toEqual(QUERY_UNAVAILABLE);
    expect(capped.baseline.result.index.entries.length).toBeGreaterThan(0);
    expect(capped.baseline.result.index.entries.length).toBeLessThan(SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET);
    expect(capped.baseline.result.index.continuation).not.toBeNull();
    expect(encodedOriginals(capped.baseline).index?.continuation).not.toBeNull();
    expect(capped.proposed.result.index.entries.length).toBeGreaterThan(0);
    expect(capped.proposed.result.index.entries.length).toBeLessThan(5);
    expect(capped.proposed.result.index.continuation).not.toBeNull();
    expect(armIdentities(capped.proposed).map(row => row.root_id)).toEqual(
      proposedIds.slice(0, capped.proposed.result.index.entries.length));
    expect(Buffer.byteLength(JSON.stringify(capped.proposed.encoded))).toBeLessThanOrEqual(byteLimit);
    expect(Buffer.byteLength(JSON.stringify(capped.baseline.encoded), "utf8"))
      .toBeLessThanOrEqual(byteLimit);
    const deliveredIds = armIdentities(capped.baseline).map((row) => row.root_id);
    expect(proposedIds.slice(0, deliveredIds.length)).toEqual(deliveredIds);
    assertUnavailableOriginalArm(capped.baseline, records, deliveredIds, (record) => record.source_body);
    for (const preview of armPreviews(capped.baseline)) {
      expect(preview).not.toBeNull();
      expect(records.some((record) => record.source_body === preview)).toBe(true);
      expect(typeof preview).toBe("string");
      expect(preview!.endsWith(" body.")).toBe(true);
    }
  });
}, 60_000);

it("treats an empty proposal as a valid selection of zero entries", async () => {
  await withOriginalLibrary(twelveSources(), async ({ database, records }) => {
    const comparison = compareResearchOriginalSourceEvidence(database, evidenceInput(records, {
      proposed_root_ids: []
    }));
    expect(comparison.query_semantics_status).toEqual(QUERY_UNAVAILABLE);
    expect(comparison.proposed.result.query_semantics_status).toEqual(QUERY_UNAVAILABLE);
    expect(comparison.proposed.result.index.entries).toEqual([]);
    expect(comparison.proposed.result.proofs).toBeUndefined();
    expect(comparison.proposed.result.index.continuation).toBeNull();
    expect(comparison.proposed.result.discovery.truncated).toBe(false);
    expect(comparison.proposed.result.discovery.open_residuals).toBe(false);
    expect(comparison.proposed.result.coverage.payload).toBe("complete");
    expect(comparison.proposed.encoded.operation).toBe("recall");
    expect(encodedOriginals(comparison.proposed).results).toEqual([]);
    expect(encodedOriginals(comparison.proposed).index?.entries).toEqual([]);
    assertUnavailableOriginalArm(
      comparison.baseline, records,
      records.slice(0, SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET).map((row) => row.record_id),
      (record) => record.source_body
    );
  });
}, 60_000);
