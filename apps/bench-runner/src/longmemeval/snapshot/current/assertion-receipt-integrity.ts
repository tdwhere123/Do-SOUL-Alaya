import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  VERIFIED_USER_ASSERTION_SOURCE_HASH_PREFIX,
  VERIFIED_USER_ASSERTION_SOURCE_HASH_V2_PREFIX,
  SoulSignalMaterializedPayloadSchema,
  parseVerifiedUserAssertionCatalogLocator,
  parseVerifiedUserAssertionSourceHash,
  verifyVerifiedUserAssertionSourceHash,
  type VerifiedUserAssertionReceiptInput,
  type VerifiedUserAssertionReceiptV2Input
} from "@do-soul/alaya-protocol";
import { verifyOfficialApiSourceLocatorBinding } from "@do-soul/alaya-soul";

interface AssertionReceiptRow {
  readonly object_id: string;
  readonly workspace_id: string;
  readonly run_id: string;
  readonly surface_id: string | null;
  readonly gist: string;
  readonly excerpt: string | null;
  readonly source_hash: string | null;
  readonly owner_count: number;
  readonly source_signal_id: string | null;
  readonly signal_workspace_id: string | null;
  readonly signal_run_id: string | null;
  readonly signal_surface_id: string | null;
  readonly signal_source: string | null;
  readonly signal_state: string | null;
  readonly raw_payload_json: string | null;
  readonly materialization_event_count: number;
  readonly materialization_caused_by: string | null;
  readonly materialization_payload_json: string | null;
}

export function assertSnapshotVerifiedAssertionReceiptIntegrity(
  dbPath: string
): Readonly<{ readonly ownerCount: number }> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const statement = db.prepare(READ_ASSERTION_RECEIPTS_SQL);
    let ownerCount = 0;
    for (const value of statement.iterate(
      `${VERIFIED_USER_ASSERTION_SOURCE_HASH_PREFIX}*`,
      `${VERIFIED_USER_ASSERTION_SOURCE_HASH_V2_PREFIX}*`
    )) {
      assertReceiptRow(value as unknown as AssertionReceiptRow);
      ownerCount += 1;
    }
    return Object.freeze({ ownerCount });
  } finally {
    db.close();
  }
}

function assertReceiptRow(row: AssertionReceiptRow): void {
  const assertion = readAssertion(row);
  const raw = assertSignalLink(row, assertion);
  const input = buildReceiptInput(row, raw, assertion);
  if (!verifyVerifiedUserAssertionSourceHash(row.source_hash, input, digestText)) {
    throw receiptError(row, "receipt digest or User-corpus authority mismatch");
  }
}

function readAssertion(row: AssertionReceiptRow): string {
  if (row.excerpt === null || row.excerpt.trim().length === 0 ||
      row.excerpt !== row.excerpt.trim()) {
    throw receiptError(row, "source assertion is missing or non-canonical");
  }
  return row.excerpt;
}

function assertSignalLink(
  row: AssertionReceiptRow,
  assertion: string
): Record<string, unknown> {
  if (row.owner_count !== 1 || row.source_signal_id === null ||
      row.materialization_event_count !== 1) {
    throw receiptError(row, "source signal ownership link is missing or ambiguous");
  }
  assertMaterializationLink(row);
  if (row.signal_workspace_id !== row.workspace_id ||
      row.signal_run_id !== row.run_id ||
      row.signal_surface_id !== row.surface_id ||
      row.signal_source !== "garden_compile" ||
      row.signal_state !== "materialized") {
    throw receiptError(row, "source signal authority does not match its owner");
  }
  const raw = parseRawPayload(row);
  if (raw.full_turn_content !== row.gist ||
      raw.source_assertion !== assertion ||
      raw.verified_user_assertion_source_hash !== row.source_hash) {
    throw receiptError(row, "source signal receipt payload does not match its owner");
  }
  return raw;
}

function assertMaterializationLink(row: AssertionReceiptRow): void {
  if (row.materialization_caused_by !== "materialization_router") {
    throw receiptError(row, "materialization event authority mismatch");
  }
  const parsed = SoulSignalMaterializedPayloadSchema.safeParse(
    parseJson(row.materialization_payload_json)
  );
  const payload = parsed.success ? parsed.data : null;
  const matchingEvidence = payload?.created_objects.filter((object) =>
    object.object_kind === "evidence_capsule" && object.object_id === row.object_id
  ) ?? [];
  if (payload === null || payload.signal_id !== row.source_signal_id ||
      payload.workspace_id !== row.workspace_id || payload.run_id !== row.run_id ||
      payload.success !== true || matchingEvidence.length !== 1) {
    throw receiptError(row, "materialization event payload mismatch");
  }
}

function buildReceiptInput(
  row: AssertionReceiptRow,
  raw: Record<string, unknown>,
  assertion: string
): VerifiedUserAssertionReceiptInput | VerifiedUserAssertionReceiptV2Input {
  const common: VerifiedUserAssertionReceiptInput = {
    workspace_id: row.workspace_id,
    run_id: row.run_id,
    surface_id: row.surface_id,
    source_assertion: assertion,
    source_corpus: row.gist
  };
  return parseVerifiedUserAssertionSourceHash(row.source_hash)?.version === 2
    ? buildV2ReceiptInput(row, raw, common)
    : common;
}

function buildV2ReceiptInput(
  row: AssertionReceiptRow,
  raw: Record<string, unknown>,
  common: VerifiedUserAssertionReceiptInput
): VerifiedUserAssertionReceiptV2Input {
  const sourceLocator = parseVerifiedUserAssertionCatalogLocator(raw.source_locator);
  if (sourceLocator === null || row.source_signal_id === null) {
    throw receiptError(row, "v2 source locator is invalid");
  }
  if (!verifyOfficialApiSourceLocatorBinding({
    sourceCorpus: row.gist,
    sourceAssertion: common.source_assertion,
    sourceLocator
  })) {
    throw receiptError(row, "v2 source locator does not resolve to its assertion");
  }
  return {
        ...common,
    signal_id: row.source_signal_id,
    source_locator: sourceLocator
  };
}

function parseRawPayload(row: AssertionReceiptRow): Record<string, unknown> {
  try {
    const parsed = JSON.parse(row.raw_payload_json ?? "null") as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // The receipt gate owns the contextual error below.
  }
  throw receiptError(row, "source signal raw payload is invalid");
}

function parseJson(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function digestText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function receiptError(row: AssertionReceiptRow, reason: string): Error {
  return new Error(
    `snapshot verified assertion receipt mismatch for ${row.object_id}: ${reason}`
  );
}

const READ_ASSERTION_RECEIPTS_SQL = `
  SELECT capsule.object_id, capsule.workspace_id, capsule.run_id,
         capsule.surface_id, capsule.gist, capsule.excerpt, capsule.source_hash,
         COALESCE(owner.owner_count, 0) AS owner_count,
         owner.signal_id AS source_signal_id,
         signal.workspace_id AS signal_workspace_id,
         signal.run_id AS signal_run_id,
         signal.surface_id AS signal_surface_id,
         signal.source AS signal_source,
         signal.signal_state,
         signal.raw_payload_json,
         COALESCE(event.event_count, 0) AS materialization_event_count,
         event.caused_by AS materialization_caused_by,
         event.payload_json AS materialization_payload_json
    FROM evidence_capsules AS capsule
    LEFT JOIN (
      SELECT workspace_id, owner_id, COUNT(*) AS owner_count,
             MIN(signal_id) AS signal_id
        FROM recall_routing_key_owners
       WHERE owner_kind = 'evidence_capsule'
       GROUP BY workspace_id, owner_id
    ) AS owner
      ON owner.workspace_id = capsule.workspace_id
     AND owner.owner_id = capsule.object_id
    LEFT JOIN signals AS signal ON signal.signal_id = owner.signal_id
    LEFT JOIN (
      SELECT entity_id, workspace_id, run_id, COUNT(*) AS event_count,
             MIN(caused_by) AS caused_by, MIN(payload_json) AS payload_json
        FROM event_log
       WHERE event_type = 'soul.signal.materialized'
         AND entity_type = 'candidate_memory_signal'
       GROUP BY entity_id, workspace_id, run_id
    ) AS event
      ON event.entity_id = owner.signal_id
     AND event.workspace_id = capsule.workspace_id
     AND event.run_id = capsule.run_id
   WHERE capsule.source_hash GLOB ? OR capsule.source_hash GLOB ?
`;
