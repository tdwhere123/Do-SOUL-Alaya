import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi, expect } from "vitest";
import { createAuditedSourceAdmission, createSourceSemanticInterpretationPublication, EvidenceService,
  fieldContractSha256, SourceIndexAcquisition } from "@do-soul/alaya-core";
import { buildSourceReferenceCatalog, sourceReferenceResolver, UNKNOWN_UTTERANCE_ATTRIBUTION } from "@do-soul/alaya-protocol";
import type { SourceEmbeddingBinding, SourceEmbeddingInput, SourceEmbeddingResult } from
  "../../../../../../packages/core/src/embedding-recall/source-embedding-runtime.js";
import { SourceIndexBackfill } from "../../../../../../packages/core/src/source-index/source-index-backfill.js";
import { SourceIndexLifecycle } from "../../../../../../packages/core/src/source-index/source-index-lifecycle.js";
import { closeCachedDatabase, SqliteEventLogRepo, SqliteSourceIndexRepository, SqliteEvidenceCapsuleRepo,
  type StorageDatabase } from "@do-soul/alaya-storage";
import { configuration, BUDGET as INDEX_BUDGET } from
  "../../../../../../packages/storage/src/__tests__/repos/source-index/source-index-fixture.js";
import { createRecallRealStorage, REAL_SQLITE_TEST_WORKSPACE_ID as WS, REAL_SQLITE_TEST_RUN_ID as RUN } from
  "../../../../../../packages/core/src/__tests__/shared/real-sqlite.test-support.js";
import { removeTempDirectorySync } from "../../../../../../packages/storage/src/__tests__/temp-directory.js";
import { createDaemonFieldRepos } from "../../../runtime/field/field-repos.js";
import { createSqliteFieldFormationStores } from "../../../runtime/field/sqlite-field-formation-stores.js";
import { createRecallReadWorkerClient, type PrepareSourceQuery } from "../../../runtime/recall/recall-read-worker-client.js";
import type { SourceSemanticsPublicPayload } from "../../../runtime/recall-read-worker/operation-schemas.js";
import { assertBuiltWorker } from "./recall-read-worker-client-fixture.js";
import { BUDGET, CLOCK, ORIGINAL, query } from "../../../../../../packages/core/src/__tests__/recall/runtime/source-semantic-proof-fixture.js";

export { WS, BUDGET, CLOCK, ORIGINAL, query };
export const digest = (text: string) => `sha256:${fieldContractSha256(text)}`;
export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
export const payload = (request: SourceSemanticsPublicPayload["request"]): SourceSemanticsPublicPayload => ({
  workspace_id: WS, as_of: CLOCK, lifetime_now: CLOCK, principal: "query-preparation-principal",
  authorized_scopes: { mode: "named", scopes: ["project"] }, request
});
export const initialQuery = () => payload({ kind: "prepare_query", original_query: ORIGINAL,
  query_semantics: query(), budget: { ...BUDGET } });
export function embedded(inputs: readonly SourceEmbeddingInput[]): readonly SourceEmbeddingResult[] {
  return inputs.map(input => ({ status: "embedded", input_id: input.input_id, input_digest: digest(input.text),
    vector: new Float32Array([0.6, 0.8, 0]), token_count: 2, truncated: false }));
}

const BODY = "Alice uses tools.";
async function publishQuerySourceInterpretation(database: StorageDatabase,
  stores: ReturnType<typeof createSqliteFieldFormationStores>) {
  const catalog = buildSourceReferenceCatalog(fieldContractSha256(BODY), [{ assertion_id: 1, text: BODY }], fieldContractSha256);
  const references = sourceReferenceResolver(catalog, fieldContractSha256);
  const mention = (id: string, text: string) => ({ id, assertion_id: 1,
    source_ref: references.referenceForSpan(1, [BODY.indexOf(text), BODY.indexOf(text) + text.length]) });
  const eventLogRepo = new SqliteEventLogRepo(database), runtimeNotifier = { notifyEntry: async () => undefined };
  const evidenceService = new EvidenceService({ eventLogRepo, runtimeNotifier,
    evidenceCapsuleRepo: new SqliteEvidenceCapsuleRepo(database), now: () => CLOCK });
  const published = await createSourceSemanticInterpretationPublication({ stores, evidenceService,
    sha256: fieldContractSha256 }).publish({ workspaceId: WS, runId: RUN, artifactKey: "query-source", source: BODY,
    catalog, attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION,
    assertion_locations: [{ assertion_id: 1, source_utf8_span: [0, Buffer.byteLength(BODY)] }],
    provenance: { producer_id: "query-preparation-fixture" }, producer_version: "1", contract_version: "source-interpretation-v4",
    draft: { contract: "source-interpretation-v4", mentions: [mention("mAlice", "Alice"), mention("mUses", "uses"), mention("mTools", "tools")],
      referents: [{ id: "rAlice", referent_kind: "grouped", mentions: ["mAlice"] },
        { id: "rTools", referent_kind: "grouped", mentions: ["mTools"] }],
      frames: [{ id: "fUse", assertion_ids: [1], context_owner: { kind: "source_act", source_act: "assertion" },
        additional_support: [], predicate_support: { kind: "explicit", reading: "use", mentions: ["mUses"] },
        slots: [{ id: "agent", role_reading: "agent", support: [{ kind: "lexical", mentions: ["mAlice"] }] },
          { id: "theme", role_reading: "theme", support: [{ kind: "lexical", mentions: ["mTools"] }] }],
        bindings: [{ slot_id: "agent", target: { kind: "node", id: "rAlice" }, support: [] },
          { slot_id: "theme", target: { kind: "node", id: "rTools" }, support: [] }] }], operators: [], gaps: [] }
  });
  return published.bound.interpretation_id;
}

export async function queryDatabase(options: { publishInterpretation?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "alaya-source-query-")), filename = join(directory, "alaya.db");
  const { database } = await createRecallRealStorage(() => undefined, filename);
  const stores = createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) });
  const admission = createAuditedSourceAdmission({ stores, eventLogRepo: new SqliteEventLogRepo(database),
    runtimeNotifier: { notifyEntry: async () => undefined }, sha256: fieldContractSha256 });
  await admission.admit({ workspace_id: WS, source_id: "query-source", source_version: "1", content_bytes: BODY,
    evidence_object_id: null, recorded_at: CLOCK, event_time: null, valid_from: null, valid_to: null,
    speaker: "user", scope_class: "project", spans: [] }, { workspaceId: WS });
  const sourceInterpretationId = options.publishInterpretation ? await publishQuerySourceInterpretation(database, stores) : undefined;
  const index = new SqliteSourceIndexRepository(database, fieldContractSha256);
  const lifecycle = new SourceIndexLifecycle(index, fieldContractSha256);
  const selection = lifecycle.select(WS, configuration({ window_bytes: 128, max_input_tokens: 64 }));
  // Controlled numerical fixture only: storage, coverage verification and activation are real.
  const binding: SourceEmbeddingBinding = { status: "ready", profile: selection.configuration.profile, profile_id: selection.profile_id,
    embedInputs: async inputs => embedded(inputs) };
  const generation = lifecycle.begin(selection);
  lifecycle.capture(WS, generation.generation_id, 8, INDEX_BUDGET);
  for (const target of index.listTargets(WS, generation.generation_id, null, 8)) {
    expect(await new SourceIndexBackfill(lifecycle).step({ selection, generation_id: generation.generation_id,
      root_key: target.root_key, binding,
      budget: { ...INDEX_BUDGET, model_inputs: 8, input_bytes: 4096, max_body_bytes: 4096 },
      signal: new AbortController().signal, deadline_ms: Date.now() + 60_000 })).toMatchObject({ status: "root_complete" });
  }
  expect(lifecycle.publish(WS, generation.generation_id)).toEqual({ status: "accepted" });
  expect(index.state(WS).status).toBe("ready");
  return { database, index, selection, binding, sourceInterpretationId, filename, directory, cleanup: () => {
    if (!database.isClosed()) database.close();
    closeCachedDatabase(filename); removeTempDirectorySync(directory);
  } };
}

export type SqlObservation = { sql: string; in_transaction: boolean };
export async function queryClient(options: { capture?: boolean; publishInterpretation?: boolean; requestTimeoutMs?: number; workerCount?: number;
  bind?: (binding: SourceEmbeddingBinding) => Promise<SourceEmbeddingBinding>;
  embed?: SourceEmbeddingBinding["embedInputs"] } = {}) {
  assertBuiltWorker();
  const h = await queryDatabase(options);
  const bind = vi.fn(async () => options.bind === undefined ? { ...h.binding,
    embedInputs: options.embed ?? h.binding.embedInputs } : await options.bind(h.binding));
  const prepare = vi.fn<PrepareSourceQuery>(input => SourceIndexAcquisition.prepareQuery({ ...input,
    selection: h.selection, bind: async () => await bind() }));
  const guard = `--import=${new URL("../../../../../bench-runner/src/__tests__/support/provider-free-cli-bootstrap.mjs", import.meta.url).href}`;
  process.execArgv.push(guard);
  const client = createRecallReadWorkerClient({ databaseFilename: options.capture ? `${h.filename}.capture` : h.filename,
    workerUrl: new URL("./source-semantic-query-worker-fixture.mjs", import.meta.url),
    workerCount: options.workerCount ?? 1, requestTimeoutMs: options.requestTimeoutMs ?? 5000,
    prepareSourceQuery: prepare })!;
  const cleanup = async () => {
    await client.close();
    const position = process.execArgv.lastIndexOf(guard);
    if (position !== -1) process.execArgv.splice(position, 1);
    h.cleanup();
  };
  try {
    await client.ready();
    const observations = (): SqlObservation[] => options.capture ? [] : readFileSync(`${h.filename}.query-sql`, "utf8")
      .trim().split("\n").map(line => JSON.parse(line) as SqlObservation);
    return { ...h, client, prepare, bind, observations, cleanup };
  } catch (error) { await cleanup(); throw error; }
}
