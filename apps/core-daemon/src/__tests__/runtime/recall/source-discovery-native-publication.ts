import { buildSourceInterpretationSignal, selectObservedTemporalProjection } from "@do-soul/alaya-soul";
import { createAuditedSourceAdmission, createSourceObservationPublication, EvidenceService, MemoryService, fieldContractSha256 } from "@do-soul/alaya-core";
import { SqliteEventLogRepo, SqliteEvidenceCapsuleRepo, SqliteMemoryEntryRepo, type StorageDatabase } from "@do-soul/alaya-storage";
import { createDaemonFieldRepos } from "../../../runtime/field/field-repos.js";
import { createSqliteFieldFormationStores } from "../../../runtime/field/sqlite-field-formation-stores.js";
import type { BoundPublicReceive } from "./source-discovery-admitted-public-publication.js";

/** Uses the same Core admission and publication owners as the daemon; no direct gist inserts. */
export async function publishCorePublicSources(input: Readonly<{
  database: StorageDatabase; bind: BoundPublicReceive; workspaceId: string; runId: string; now: string;
}>) {
  if (input.bind.status !== "complete") return [];
  const eventLogRepo = new SqliteEventLogRepo(input.database);
  const runtimeNotifier = { notifyEntry: async () => undefined };
  const repos = createDaemonFieldRepos({ database: input.database });
  const stores = createSqliteFieldFormationStores({ database: input.database, repos });
  const evidenceService = new EvidenceService({ eventLogRepo, runtimeNotifier, now: () => input.now,
    evidenceCapsuleRepo: new SqliteEvidenceCapsuleRepo(input.database) });
  const memoryService = new MemoryService({ eventLogRepo, runtimeNotifier, evidenceService, now: () => input.now,
    memoryEntryRepo: new SqliteMemoryEntryRepo(input.database) });
  const publication = createSourceObservationPublication({ stores, evidenceService, memoryService,
    sha256: fieldContractSha256, deriveTemporalProjection: (assertion, observedAt) =>
      selectObservedTemporalProjection(assertion, undefined, observedAt ?? undefined) ?? {},
    sourceAdmission: createAuditedSourceAdmission({ stores, eventLogRepo, runtimeNotifier, sha256: fieldContractSha256 }) });
  const published = [];
  for (const located of input.bind.receive.located) {
    if (located.outcome !== "candidates") continue;
    const signal = buildSourceInterpretationSignal({ located,
      signalId: `source-observation-${located.assertion_binding.assertion_id}`,
      workspaceId: input.workspaceId, runId: input.runId, surfaceId: null, scopeHint: "project",
      sourceObservation: { observed_at: input.now, authority: "trusted_host_event", source_event_id: "event-source" },
      createdAt: input.now });
    published.push(await publication.publish({ signal, sourceEventAnchor: null }));
  }
  return published;
}
