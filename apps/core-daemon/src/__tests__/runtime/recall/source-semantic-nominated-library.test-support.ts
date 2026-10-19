import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { expect } from "vitest";
import { unavailableSourceQueryPreparation, type IndexEntry, type SourceIndexConfiguration, type SourceSemanticQuery } from "@do-soul/alaya-protocol";
import { createAuditedSourceAdmission, SourceIndexLifecycle, fieldContractSha256, sourceGoldRootIdentity,
  sourceSemanticLibrarySourceEntry } from "@do-soul/alaya-core";
import { closeCachedDatabase, SqliteEventLogRepo, SqliteSourceIndexRepository } from "@do-soul/alaya-storage";
import { createRecallRealStorage } from "../../../../../../packages/core/src/__tests__/shared/real-sqlite.test-support.js";
import { createDaemonFieldRepos } from "../../../runtime/field/field-repos.js";
import { createSqliteFieldFormationStores } from "../../../runtime/field/sqlite-field-formation-stores.js";
import { createRecallReadWorkerRuntime } from "../../../runtime/recall-read-worker/runtime.js";
import { observeSourceSemanticAccess } from "../../../runtime/recall-read-worker/source-semantic-candidate-access.js";
import { sourceSemanticRevision } from "../../../runtime/recall-read-worker/source-semantic-leases.js";
import type { SourceSemanticWorkerPayload } from "../../../runtime/recall-read-worker/source-semantic-discovery.js";
import { SourceSemanticReadBudget } from "../../../runtime/field/source-semantic-read-stores.js";
import type { compareResearchNominatedSourceLibrary } from "../../../runtime/recall-read-worker/source-semantic-research-nominated-library.js";
import type { LibrarySourceNomination } from "../../../runtime/recall-read-worker/source-semantic-library-nominated-windows.js";
import { ACCESS_BUDGET, WS, CLOCK } from "./source-semantic-access.test-support.js";

export { ACCESS_BUDGET, WS, CLOCK };
export const ORIGINAL = "Why delayed?";
export const CONDITION = "Unless the permit is paused, ";
export const ANSWER = "the harbor opens on Tuesday";
export const BODY = `${"x".repeat(8192)}${CONDITION}${ANSWER}.${"尾😀".repeat(500)}`;
export const digest = (value: string) => `sha256:${fieldContractSha256(value)}`;
const configuration: SourceIndexConfiguration = { revision: "finite-navigation-v1", profile: {
  provider_kind: "local_onnx", model_id: "authored-axes-no-inference", model_revision: "fixture-v1",
  artifact_digest: digest("authored axes"), tokenizer_revision: "fixture-v1", dimensions: 3,
  preprocessing: "exact-utf8", normalization: "none", max_input_tokens: 32,
  windowing: "utf8-byte-windows.v1", window_bytes: 1024
} };
const INDEX_BUDGET = { work: 100_000, native_bytes: 16_000_000 };

/** Real publication/index/acquisition; vectors are explicitly authored finite axes, not model output. */
export async function nominatedLibraryContext(query?: SourceSemanticQuery) {
  const directory = await mkdtemp(join(tmpdir(), "nominated-source-library-")), filename = join(directory, "alaya.db");
  const { database } = await createRecallRealStorage(() => undefined, filename);
  try {
    const admission = createAuditedSourceAdmission({
      stores: createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) }),
      eventLogRepo: new SqliteEventLogRepo(database), runtimeNotifier: { notifyEntry: async () => undefined }, sha256: fieldContractSha256
    });
    const fixtures = [{ id: "answer", text: BODY }, ...Array.from({ length: 4 }, (_, index) => ({
      id: `other-${index}`, text: `User: unrelated granite wall ${index}.`
    }))];
    const records = [];
    for (const source of fixtures) records.push((await admission.admit({ workspace_id: WS,
      source_id: source.id, source_version: "1", content_bytes: source.text, recorded_at: CLOCK,
      event_time: null, valid_from: null, valid_to: null, speaker: "user", scope_class: "project",
      evidence_object_id: null, spans: [] }, { workspaceId: WS })).record);
    const repo = new SqliteSourceIndexRepository(database, fieldContractSha256), lifecycle = new SourceIndexLifecycle(repo, fieldContractSha256);
    const selection = lifecycle.select(WS, configuration), generation = lifecycle.begin(selection);
    const captured = lifecycle.capture(WS, generation.generation_id, 128, INDEX_BUDGET);
    expect(captured.generation.enumeration_complete).toBe(true);
    const targets = repo.listTargets(WS, generation.generation_id, null, 128);
    for (const target of targets) {
      const prepared = lifecycle.prepare(WS, generation.generation_id, target.root_key, INDEX_BUDGET);
      if (prepared.status !== "ready") throw new Error("fixture source manifest unavailable");
      for (const window of prepared.document.windows) expect(lifecycle.acceptVector(WS, generation.generation_id, {
        window_id: window.window_id, input_digest: window.content_digest,
        embedding: new Float32Array(window.text.includes(ANSWER) ? [1, 0, 0] : [0, 1, 0]), token_count: 2, truncated: false
      })).toEqual({ status: "accepted" });
    }
    expect(lifecycle.publish(WS, generation.generation_id)).toEqual({ status: "accepted" });
    const payload: SourceSemanticWorkerPayload = { workspace_id: WS, as_of: CLOCK,
      authorized_scopes: { mode: "named", scopes: ["project"] }, request: {
        kind: "recall", accepts_unreviewed_conditional_results: true, original_query: ORIGINAL,
        ...(query === undefined ? {} : { query_semantics: query }),
        semantic_correspondences: [], access_policy: "query-conditioned-v1", budget: ACCESS_BUDGET, output_byte_limit: 300_000
      }, prepared_query: { receipt: unavailableSourceQueryPreparation("authored finite axes; no inference", "not_requested"),
        vector: { status: "available", profile: configuration.profile, profile_id: selection.profile_id,
          input_digest: digest(ORIGINAL), embedding: new Float32Array([1, 0, 0]) } } };
    const runtime = createRecallReadWorkerRuntime(database), meter = new SourceSemanticReadBudget(ACCESS_BUDGET);
    // A rejected Q is deliberately not used to replace the unchanged original navigation.
    const pool = database.connection.transaction(() => observeSourceSemanticAccess(runtime, payload, ["project"], meter,
      ORIGINAL, undefined, "query-conditioned-v1", ACCESS_BUDGET))();
    return { database, runtime, filename, pool, meter, records, payload, close: async () => {
      database.close(); closeCachedDatabase(filename); await rm(directory, { recursive: true, force: true });
    } };
  } catch (error) {
    database.close(); closeCachedDatabase(filename); await rm(directory, { recursive: true, force: true }); throw error;
  }
}
export type NominatedLibraryContext = Awaited<ReturnType<typeof nominatedLibraryContext>>;

/** Census-scale raw hydration only: no index, query provider or external dataset. */
export async function censusNominatedLibraryContext() {
  const directory = await mkdtemp(join(tmpdir(), "nominated-source-census-")), filename = join(directory, "alaya.db");
  const { database } = await createRecallRealStorage(() => undefined, filename);
  const close = async () => {
    database.close(); closeCachedDatabase(filename); await rm(directory, { recursive: true, force: true });
  };
  try {
    const admission = createAuditedSourceAdmission({
      stores: createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) }),
      eventLogRepo: new SqliteEventLogRepo(database), runtimeNotifier: { notifyEntry: async () => undefined }, sha256: fieldContractSha256
    });
    const sources: IndexEntry[] = [], nominations: LibrarySourceNomination[] = [], bodies: string[] = [];
    for (let index = 0; index < 475; index++) {
      const body = `${index.toString().padStart(4, "0")}:${String.fromCharCode(97 + index % 26).repeat((index < 16 ? 1216 : 1044) - 5)}`;
      const source_id = `source-${index.toString().padStart(3, "0")}`;
      const { record } = await admission.admit({ workspace_id: WS, source_id, source_version: "1", content_bytes: body,
        recorded_at: CLOCK, event_time: null, valid_from: null, valid_to: null, speaker: "user", scope_class: "project",
        evidence_object_id: null, spans: [] }, { workspaceId: WS });
      const entry = sourceSemanticLibrarySourceEntry({ workspaceId: WS, root_id: record.identity,
        source_version: record.source_version, content_digest: record.content_digest,
        evidence_object_id: record.evidence_object_id, hypothesis_id: "source-navigation" });
      sources.push(entry); bodies.push(body);
      if (index < 16) {
        if (entry.target.kind !== "source_evidence") throw new Error("source fixture target required");
        const start = 500 + index, end = start + 334;
        nominations.push({ source: { root_key: sourceGoldRootIdentity(entry.target), source_id,
          target: entry.target, body_bytes: Buffer.byteLength(body) }, lexical: [], vector: {
          rank: index + 1, cosine: 1 - index / 32, window: { window_id: digest(`window-${index}`),
            start_byte: start, end_byte: end, content_digest: digest(body.slice(start, end)) }
        } });
      }
    }
    const payload: SourceSemanticWorkerPayload = { workspace_id: WS, as_of: CLOCK,
      authorized_scopes: { mode: "named", scopes: ["project"] }, request: {
        kind: "recall", original_query: "Locate the retained source intervals", accepts_unreviewed_conditional_results: true,
        access_policy: "query-conditioned-v1", budget: { ...ACCESS_BUDGET, memory_bytes: 60_000_000,
          page_budget: 10_000, finalization_reserve: 50_000 }, output_byte_limit: 300_000
      } };
    return { database, filename, runtime: createRecallReadWorkerRuntime(database), payload, sources, nominations, bodies, close };
  } catch (error) { await close(); throw error; }
}

/** Guard precedes SQLite; the transported parent capture is a rejection control, not worker authority. */
export async function compareInGuardedWorker(context: NominatedLibraryContext) {
  const guard = new URL("../../../../../bench-runner/src/__tests__/support/provider-free-cli-bootstrap.mjs", import.meta.url);
  const worker = new Worker(new URL("./source-semantic-nominated-library-worker-fixture.mjs", import.meta.url), {
    execArgv: [`--import=${guard.href}`], workerData: { filename: context.filename, payload: context.payload, pool: context.pool,
      revision: sourceSemanticRevision(context.runtime), costs: { work: context.meter.spentWork, bytes: context.meter.spentBytes,
        nativeWork: context.meter.nativeWork, nativeBytes: context.meter.nativeBytes, indexWork: context.meter.indexWork,
        preparation: context.meter.preparation, acquisition: context.meter.acquisition } }
  });
  try {
    return await new Promise<ReturnType<typeof compareResearchNominatedSourceLibrary>>((resolve, reject) => {
      let received = false, result: ReturnType<typeof compareResearchNominatedSourceLibrary>;
      worker.once("message", message => {
        if (message.error !== undefined) { reject(new Error(message.error)); return; }
        result = message.result; received = true;
      });
      worker.once("error", reject);
      worker.once("exit", code => code === 0 && received ? resolve(result) : reject(new Error(`guarded worker exit ${code}`)));
    });
  } finally { await worker.terminate(); }
}
