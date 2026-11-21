import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildAssociativeFactKeyProjections, type AssociativeFactFrame, type EvidenceCapsule } from "@do-soul/alaya-protocol";
import { initDatabase, type StorageDatabase } from "../../../../../sqlite/db.js";
import { SqliteEvidenceCapsuleRepo } from "../../../../../repos/capsules/evidence-capsule-repo.js";
import { readObjectKeyEvidenceSources } from "../../../../../repos/capsules/reads/object-key-source-reader.js";
import { createEvidenceCapsuleRepo, evidenceCapsuleDatabases } from "../../evidence-capsule-repo-fixture.js";
import { removeTempDirectorySync } from "../../../../temp-directory.js";
import { assertionCapsule, insertMaterializationEvent, persistAssertionSignal, verifiedAssertionSourceHash } from
  "./verified-assertion-qualification-fixture.js";

const directories = new Set<string>();
afterEach(() => {
  for (const db of evidenceCapsuleDatabases) db.close();
  evidenceCapsuleDatabases.clear();
  for (const directory of directories) removeTempDirectorySync(directory);
  directories.clear();
});

const frame: AssociativeFactFrame = { schema_version: 1, slots: [
  { role: "subject", text: "I" }, { role: "qualifier", text: "can" },
  { role: "relation", text: "enter" }, { role: "value", text: "the lab" }
] };

it.each([
  "I can enter the lab only if I have a badge.",
  "I can enter the lab without a badge.",
  "I can enter the lab with a badge.",
  "I can enter the lab except on Sundays.",
  "I can enter the lab after the surgery.",
  "I can enter the lab or use the equipment.",
  "Without the badge I can enter the lab."
])("keeps historical source receipts while refusing incomplete derived views after reopen: %s", async (source) => {
  await assertHistoricalRead(source, frame, false);
});

it("refuses a historical frame that loses modality while its v1 source proof still qualifies", async () => {
  await assertHistoricalRead("I can enter the lab.", { ...frame,
    slots: frame.slots.filter(({ role }) => role !== "qualifier") }, false);
});

it.each([
  { source: "I can enter the lab or use the equipment.", subject: "I", qualifier: "can", relation: "use" },
  { source: "Alice enters the lab or uses the equipment.", subject: "Alice enters the lab or", relation: "uses" }
])("refuses historical frames whose proposed anchors skip the primary source predicate: $subject", async (entry) => {
  await assertHistoricalRead(entry.source, { schema_version: 1, slots: [
    { role: "subject", text: entry.subject },
    ...(entry.qualifier === undefined ? [] : [{ role: "qualifier" as const, text: entry.qualifier }]),
    { role: "relation", text: entry.relation }, { role: "value", text: "the equipment" }
  ] }, false);
});

it.each(["I can enter the lab.", "I have entered the lab."])(
  "keeps supported historical source frames and normalized auxiliaries readable: %s", async (source) => {
    await assertHistoricalRead(source, source.includes("entered") ? { schema_version: 1, slots: [
      { role: "subject", text: "I" }, { role: "relation", text: "entered" }, { role: "value", text: "the lab" }
    ] } : frame, true);
  });

async function assertHistoricalRead(source: string, factFrame: AssociativeFactFrame, supported: boolean): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "alaya-historical-source-"));
  directories.add(directory);
  const filename = join(directory, "source.sqlite");
  const { database, repo } = await createEvidenceCapsuleRepo(filename);
  const corpus = `User: ${source}`;
  const capsule = assertionCapsule("cccccccc-1111-4111-8111-cccccccccccc", {
    excerpt: source, gist: corpus,
    source_hash: verifiedAssertionSourceHash(source, corpus, { workspace_id: "workspace-1", run_id: "run-1", surface_id: null })
  });
  await repo.create(capsule);
  const signal = await persistAssertionSignal(database);
  database.connection.prepare("UPDATE signals SET raw_payload_json = ? WHERE signal_id = ?").run(JSON.stringify({
    ...signal.raw_payload, source_assertion: source, full_turn_content: corpus,
    verified_user_assertion_source_hash: capsule.source_hash, distilled_fact: source, fact_frame: factFrame,
    source_grounding: { version: 1, status: "grounded", content_basis: "source_assertion", source_assertion: source,
      proposed_matched_text: source, reasons: [] }
  }), signal.signal_id);
  insertMaterializationEvent(database, signal, capsule);
  insertFactKeys(database, capsule, factFrame);
  database.close();
  evidenceCapsuleDatabases.delete(database);
  const reopened = initDatabase({ filename });
  evidenceCapsuleDatabases.add(reopened);
  const reader = new SqliteEvidenceCapsuleRepo(reopened);
  const [qualified] = await reader.findRecallQualifiedByIds("workspace-1", [{ object_id: capsule.object_id }]);
  expect(qualified?.capsule.excerpt).toBe(source);
  expect(readObjectKeyEvidenceSources(reopened, "workspace-1", [capsule.object_id]))
    .toEqual([{ object_id: capsule.object_id, gist: corpus }]);
  const readKeys = reader.findRecallQualifiedFactKeysByIds("workspace-1", [capsule.object_id]);
  if (supported) {
    await expect(readKeys).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ matched_fact_frame: factFrame })
    ]));
  } else {
    await expect(readKeys).rejects.toThrow("requested fact key does not match its source assertion");
  }
  expect(reader.boundedSourceReader().read("workspace-1", capsule.object_id, 65_536, 0)?.prefix?.toString("utf8")).toBe(source);
}

function insertFactKeys(db: StorageDatabase, capsule: EvidenceCapsule, frame: AssociativeFactFrame): void {
  const insert = db.connection.prepare(`
    INSERT INTO evidence_search_projections (
      evidence_object_id, projection_id, projection_kind, workspace_id, source_hash, content
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const projection of buildAssociativeFactKeyProjections(frame)) {
    insert.run(capsule.object_id, projection.projection_id, projection.projection_kind,
      capsule.workspace_id, capsule.source_hash, projection.content);
  }
}
