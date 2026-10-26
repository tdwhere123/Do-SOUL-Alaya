import { afterEach, expect, it } from "vitest";
import { hashAddressableSourceSpanId, SOURCE_SPAN_IDENTITY_OPERATOR_ID, sourceRecallTarget } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../../sqlite/db.js";
import { SqliteEvidenceCapsuleRepo } from "../../../repos/capsules/evidence-capsule-repo.js";
import { SqliteFieldSourceRecordRepo, SqliteFieldSourceSpanRepo } from "../../../repos/field/source-repo.js";
import { SqliteSourceRootRecallReader } from "../../../repos/field/bounded-source-root-reader.js";
import { CLOCK, fieldSha256, hashedRecord, openFieldDatabase } from "./field-contract-fixture.js";

const databases: StorageDatabase[] = [];
afterEach(() => { databases.forEach(database => database.close()); databases.length = 0; });

function rootWithLines(lineCount: number, messageEnds: readonly number[] | null) {
  const database = openFieldDatabase();
  databases.push(database);
  const line = `${"word ".repeat(19)}\n`;
  const body = line.repeat(lineCount);
  const record = new SqliteFieldSourceRecordRepo(database, fieldSha256).insert(hashedRecord("workspace-1", body, "src-long"));
  const spans = new SqliteFieldSourceSpanRepo(database, fieldSha256);
  const insert = (start: number, end: number, purpose: "line" | "message") => spans.insert({
    span_id: hashAddressableSourceSpanId({ record_id: record.record_id, start_offset: start, end_offset: end, purpose,
      producer_version: SOURCE_SPAN_IDENTITY_OPERATOR_ID }, fieldSha256),
    record_id: record.record_id, start_offset: start, end_offset: end, purpose,
    producer_version: SOURCE_SPAN_IDENTITY_OPERATOR_ID, workspace_id: "workspace-1", recorded_at: CLOCK });
  for (let i = 0; i < lineCount; i++) insert(i * line.length, (i + 1) * line.length, "line");
  let start = 0;
  for (const end of messageEnds ?? []) { insert(start, end, "message"); start = end; }
  const reader = new SqliteSourceRootRecallReader(new SqliteFieldSourceRecordRepo(database, fieldSha256),
    new SqliteEvidenceCapsuleRepo(database));
  const target = sourceRecallTarget({ workspace_id: "workspace-1", root_kind: "source_record", root_id: record.record_id,
    source_version: record.source_version, content_digest: record.content_digest, evidence_object_id: null });
  return { reader, target, lineBytes: line.length, bodyBytes: body.length };
}

it("reads only the delivery unit's ends inside the hydrated window, independent of root size", () => {
  const small = rootWithLines(20, [1000, 2000]);
  const large = rootWithLines(800, [1000, 2000, 80_000]);
  const pages = [small, large].map(({ reader, target }) => reader.hydrate("workspace-1", target, 1500, 0, 500_000, 10_000, true));
  for (const page of pages) {
    expect(page.row?.content_end).toBe(1500);
    expect(page.row?.delivery_boundaries).toEqual({ status: "available", spans: [{ purpose: "message", end_offset: 1000 }] });
  }
  expect(pages[1]!.metadataBytes).toBe(pages[0]!.metadataBytes);
  expect(pages[1]!.nativeWork).toBe(pages[0]!.nativeWork);
  const later = large.reader.hydrate("workspace-1", large.target, 1500, 1000, 500_000, 10_000, true);
  expect(later.row?.delivery_boundaries).toEqual({ status: "available", spans: [{ purpose: "message", end_offset: 2000 }] });
});

it("falls back to line ends in the window when the root records no message", () => {
  const { reader, target, lineBytes } = rootWithLines(800, null);
  const page = reader.hydrate("workspace-1", target, 1500, 0, 500_000, 10_000, true);
  const ends = Array.from({ length: Math.floor(1500 / lineBytes) }, (_, i) => ({ purpose: "line", end_offset: (i + 1) * lineBytes }));
  expect(page.row?.delivery_boundaries).toEqual({ status: "available", spans: ends });
  const bounded = reader.hydrate("workspace-1", target, 1500, 0, 500_000, (page.nativeWork ?? 0) - 1, true);
  expect(bounded.row?.delivery_boundaries).toEqual({ status: "unavailable", reason: "resource_limited" });
});
