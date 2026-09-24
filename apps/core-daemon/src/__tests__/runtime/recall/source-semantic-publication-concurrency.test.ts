import { expect, it } from "vitest";
import { buildSourceReferenceCatalog, sourceReferenceResolver, UNKNOWN_UTTERANCE_ATTRIBUTION } from "@do-soul/alaya-protocol";
import { createAuditedSourceAdmission, createSourceSemanticInterpretationPublication, EvidenceService,
  fieldContractSha256 } from "@do-soul/alaya-core";
import { closeCachedDatabase, SqliteEventLogRepo, SqliteEvidenceCapsuleRepo } from "@do-soul/alaya-storage";
import { createDaemonFieldRepos } from "../../../runtime/field/field-repos.js";
import { createSqliteFieldFormationStores } from "../../../runtime/field/sqlite-field-formation-stores.js";
import { deriveAddressableSpanViews } from "../../../../../../packages/core/src/memory/evidence-create/source-span-views.js";
import { createRecallRealStorage, REAL_SQLITE_TEST_RUN_ID as RUN } from
  "../../../../../../packages/core/src/__tests__/shared/real-sqlite.test-support.js";
import { withAccessLibrary, WS, CLOCK } from "./source-semantic-access.test-support.js";

it("returns the stored envelope for concurrent equivalent publications and rejects a revised source", async () => {
  const text = "Ada sealed crate.";
  const source = `User: ${text}`;
  await withAccessLibrary([{ id: "record", text }], async ({ filename }) => {
    const { database } = await createRecallRealStorage(() => undefined, filename);
    try {
      const eventLogRepo = new SqliteEventLogRepo(database);
      const stores = createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) });
      const runtimeNotifier = { notifyEntry: async () => undefined };
      const evidenceService = new EvidenceService({ evidenceCapsuleRepo: new SqliteEvidenceCapsuleRepo(database),
        eventLogRepo, runtimeNotifier, now: () => CLOCK });
      let releaseFirstReads: () => void = () => undefined;
      const firstReadsDone = new Promise<void>(resolve => { releaseFirstReads = resolve; });
      const firstReads: boolean[] = [];
      const publication = createSourceSemanticInterpretationPublication({ stores, sha256: fieldContractSha256,
        evidenceService: { create: evidenceService.create.bind(evidenceService),
          findByIdScoped: async (objectId: string, workspaceId: string) => {
            const found = await evidenceService.findByIdScoped(objectId, workspaceId);
            if (firstReads.length < 2) {
              firstReads.push(found === null);
              if (firstReads.length === 2) releaseFirstReads();
              await firstReadsDone;
            }
            return found;
          } } });
      const catalog = buildSourceReferenceCatalog(fieldContractSha256(text), [{ assertion_id: 1, text }], fieldContractSha256);
      const source_ref = sourceReferenceResolver(catalog, fieldContractSha256).referenceForSpan(1, [0, text.length]);
      const input = { workspaceId: WS, runId: RUN, artifactKey: "record", source, catalog,
        attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION,
        assertion_locations: [{ assertion_id: 1, source_utf8_span: [6, Buffer.byteLength(source)] as const }],
        producer_version: "test-author", contract_version: "source-interpretation-v4",
        draft: { contract: "source-interpretation-v4", mentions: [{ id: "mention", assertion_id: 1, source_ref }],
          referents: [], frames: [{ id: "seal", assertion_ids: [1],
            context_owner: { kind: "source_act", source_act: "assertion" }, additional_support: [],
            predicate_support: { kind: "explicit", reading: "sealed", mentions: ["mention"] },
            slots: [], bindings: [] }], operators: [], gaps: [] } } as const;
      const published = await Promise.all(["first", "second"].map(request_key => publication.publish({ ...input,
        provenance: { producer_id: "test-author", request_key, raw_response_id: `raw-${request_key}` } })));
      expect(firstReads).toEqual([true, true]);
      const rows = database.connection.prepare("SELECT gist FROM evidence_capsules WHERE object_id = ?").all(
        published[0]!.evidence.object_id) as { gist: string }[];
      expect(rows).toHaveLength(1);
      const durable = JSON.parse(rows[0]!.gist);
      for (const result of published) {
        expect(result.bound).toEqual(durable);
        expect(JSON.parse(result.evidence.gist)).toEqual(durable);
      }
      expect(published[0]!.bound).toEqual(published[1]!.bound);

      const revised = "User: Ada opened crate.";
      const admission = createAuditedSourceAdmission({ stores, eventLogRepo, runtimeNotifier,
        sha256: fieldContractSha256 });
      await admission.admit({ workspace_id: WS, source_id: "record", source_version: "2", content_bytes: revised,
        evidence_object_id: null, recorded_at: "2026-09-19T00:00:00.000Z", event_time: null,
        valid_from: null, valid_to: null, speaker: "user", scope_class: "project",
        spans: deriveAddressableSpanViews(revised) }, { workspaceId: WS });
      await expect(publication.publish({ ...input,
        provenance: { producer_id: "test-author", request_key: "after-revision" } }))
        .rejects.toThrow(/digest is not current|source.*current/u);
      expect(database.connection.prepare("SELECT COUNT(*) AS n FROM evidence_capsules WHERE object_id = ?")
        .get(published[0]!.evidence.object_id)).toEqual({ n: 1 });
    } finally {
      database.close();
      closeCachedDatabase(filename);
    }
  });
});
